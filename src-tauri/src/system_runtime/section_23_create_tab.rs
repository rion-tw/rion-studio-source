impl SystemRuntimeExecutor {
    fn create_tab(&self, tab: EmbeddedTabEffectRecord) -> RuntimeResult<()> {
        let launch_started = Instant::now();
        if tab
            .roles
            .iter()
            .any(|role| !is_current_system_engine(role.resolved_engine))
        {
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_ENGINE_MISMATCH",
                "This tab did not resolve to the current platform System WebView.",
            ));
        }
        {
            let state = self.state()?;
            if state.tabs.contains_key(&tab.tab_id) {
                return Err(RuntimeError::new(
                    "TAURI_RUNTIME_TAB_DUPLICATE",
                    "The System WebView tab already exists.",
                ));
            }
            if tab.roles.iter().any(|role| {
                state
                    .close_coordinator
                    .closing_roles
                    .contains(&role.role.id)
                    || state
                        .close_coordinator
                        .quarantined_roles
                        .contains(&role.role.id)
                    || state.surface_registry.values().any(|surface| {
                        surface.role_id.as_deref() == Some(role.role.id.as_str())
                            && surface.phase.blocks_role_relaunch()
                    })
            }) {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "A closing or quarantined native surface still owns this role. Restart Rion Studio before reopening it.",
                ));
            }
        }
        // Surface creation uses the observer's last confirmed LocalStorage snapshot. A live
        // JavaScript refresh can take up to thirty seconds on an unresponsive source page and
        // must never delay tab reservation or native controller attachment.
        let target = tab.target.clone();
        let tab_type = if tab.workspace_id.is_some() {
            "workspace"
        } else {
            "role"
        };
        // Read the cancellation fence before waiting for any native window work. Closing a
        // provisional tab must abort the pending Core launch instead of creating a replacement
        // tab that the user already dismissed.
        let launch_preview =
            self.take_tab_launch_preview(&target.window_id, &tab.source_id, tab_type)?;
        let (window, native_host_created) = self
            .with_native_creation_lane(&target.window_id, || {
                self.ensure_display_host(&target, &tab.name)
            })?;
        let host_created = native_host_created
            || launch_preview
                .as_ref()
                .is_some_and(|preview| preview.host_created);
        let should_select = launch_preview.as_ref().is_none_or(|preview| {
            self.presentation
                .existing(&target.window_id)
                .and_then(|presentation| {
                    presentation.lock().ok().map(|selection| {
                        selection.selected_tab_id.as_deref() == Some(preview.id.as_str())
                    })
                })
                .unwrap_or(true)
        });
        let created_tab_id = tab.tab_id.clone();
        let reservation_revision = self.presentation.next_revision();
        {
            let mut state = self.state()?;
            state.tabs.insert(
                created_tab_id.clone(),
                RuntimeTab {
                    active_divider_resize: None,
                    audio_muted: false,
                    dividers: Vec::new(),
                    window_id: target.window_id.clone(),
                    roles: HashMap::new(),
                    workspace_id: tab.workspace_id.clone(),
                    workspace_appearance: tab.workspace_appearance.clone(),
                    #[cfg(any(windows, target_os = "macos"))]
                    workspace_template: tab.workspace_template.clone(),
                },
            );
            state
                .launch_phases
                .insert(created_tab_id.clone(), LaunchPhase::Attaching);
        }
        let presentation = self
            .presentation
            .coordinator(&target.window_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        let (previous_tab_id, previous_surfaces) = {
            let mut selection = presentation.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            let previous_tab_id = selection.selected_tab_id.clone();
            let previous_surfaces = selection.surfaces(previous_tab_id.as_deref());
            let presentation_tab = TabPresentation {
                closable: true,
                icon_data_url: None,
                id: created_tab_id.clone(),
                phase: TabPresentationPhase::Attaching,
                role_ids: tab.roles.iter().map(|role| role.role.id.clone()).collect(),
                source_id: tab.source_id.clone(),
                tab_type: tab_type.to_owned(),
                title: tab.name.clone(),
                #[cfg(any(windows, target_os = "macos"))]
                workspace_template: tab.workspace_template.clone(),
            };
            if let Some(preview) = launch_preview.as_ref() {
                selection.replace_tab_id(&preview.id, presentation_tab, reservation_revision);
                if !should_select
                    && selection.selected_tab_id.as_deref() == Some(created_tab_id.as_str())
                {
                    selection.select(previous_tab_id.clone(), reservation_revision);
                }
            } else {
                selection.insert_tab(presentation_tab, reservation_revision, should_select);
            }
            if should_select {
                selection.select(Some(created_tab_id.clone()), reservation_revision);
            }
            (previous_tab_id, previous_surfaces)
        };
        self.publish_launcher_presence();
        self.record_runtime_stage(
            format!("tab-reserved:{}:{}", target.window_id, created_tab_id),
            "completed",
            launch_started,
        );
        self.record_runtime_stage(
            format!(
                "prewarm-{}:{}",
                if self.prewarm_state.load(Ordering::Acquire) == 2 {
                    "hit"
                } else {
                    "miss"
                },
                created_tab_id
            ),
            "completed",
            launch_started,
        );
        let active_tab_id =
            self.presentation
                .existing(&target.window_id)
                .and_then(|presentation| {
                    presentation
                        .lock()
                        .ok()
                        .and_then(|selection| selection.selected_tab_id.clone())
                });
        if let Some(preview) = launch_preview.as_ref() {
            let _ = self.replace_native_tab_reservation(
                &target.window_id,
                &preview.id,
                &created_tab_id,
                &tab.name,
                tab_type,
                tab.workspace_template.as_deref(),
                active_tab_id.as_deref(),
                reservation_revision,
            );
        } else {
            let _ = self.reserve_native_tab(
                &target.window_id,
                &created_tab_id,
                &tab.name,
                tab_type,
                tab.workspace_template.as_deref(),
                reservation_revision,
            );
        }
        self.dispatch_native_presentation(
            target.window_id.clone(),
            Some(created_tab_id.clone()),
            reservation_revision,
            "launch-reserved",
            Instant::now(),
            window.clone(),
            previous_tab_id,
            previous_surfaces,
            Vec::new(),
            None,
            Some(true),
            NativePresentationFocus::None,
        );
        self.wait_for_presentation_paint_barrier(&target.window_id, reservation_revision);
        let window_zoom_factor = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| host.zoom_factor)
            .unwrap_or(1.0);
        let mut created_surfaces = Vec::new();
        let mut first_surface_recorded = false;
        let mut first_navigation_recorded = false;
        let mut result = (|| -> RuntimeResult<()> {
            let content_metrics = runtime_window_content_metrics(&window)?;
            let role_inputs = tab
                .roles
                .iter()
                .map(|role| LayoutRoleInput {
                    role_id: role.role.id.clone(),
                    rect: LayoutRect {
                        x: role.rect.x,
                        y: role.rect.y,
                        width: role.rect.width,
                        height: role.rect.height,
                    },
                })
                .collect::<Vec<_>>();
            for role in &tab.roles {
                let role_id = role.role.id.clone();
                let generation = self.claim_surface_generation(&role_id)?;
                let sync_config =
                    role.local_storage_sync
                        .as_ref()
                        .map(|sync| LocalStorageRuntimeConfig {
                            codec: sync.codec.clone(),
                            dependent_role_ids: sync.dependent_role_ids.clone(),
                            generation: 1,
                            keys: sync.keys.clone(),
                            selectors: sync.selectors.clone(),
                            origin: sync.origin.clone(),
                            source_role_id: sync
                                .source
                                .as_ref()
                                .map(|source| source.role_id.clone()),
                            token: uuid::Uuid::new_v4().to_string(),
                        });
                let navigation = Arc::new(NavigationTracker::default());
                let callback_navigation = Arc::clone(&navigation);
                let role_label =
                    runtime_label("game-role", &format!("{role_id}:generation-{generation}"));
                let navigation_app = self.app.clone();
                let navigation_label = role_label.clone();
                let paths = role_session_paths(&self.user_data_dir, &role_id)?;
                fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
                let (builder, high_refresh_rate_status) =
                    self.role_webview_builder(role_label, &paths, &role_id)?;
                let mut builder = builder.on_page_load(move |_webview, payload| {
                    callback_navigation.page_event(payload.event(), payload.url());
                    if payload.event() == PageLoadEvent::Finished
                        && let Some(state) = navigation_app.try_state::<crate::CoreState>()
                    {
                        state
                            .runtime
                            .finish_navigation_page(&navigation_label, payload.url());
                    }
                });
                if let Some(config) = sync_config.as_ref() {
                    builder = builder.initialization_script_for_all_frames(
                        &local_storage_sync_observer_script(config)?,
                    );
                    if let Some(source_role_id) = config.source_role_id.as_deref() {
                        let snapshot = self.load_local_storage_sync_snapshot(
                            source_role_id,
                            &config.origin,
                            &config.keys,
                            &config.selectors,
                            config.codec.as_deref(),
                        )?;
                        builder = builder.initialization_script_for_all_frames(
                            &local_storage_sync_apply_script(&snapshot)?,
                        );
                    }
                }
                // The normalized role rectangle is sufficient for the first frame. Exact gap,
                // divider and adaptive-zoom layout runs after every role controller has attached,
                // so Core layout work can no longer delay the first native game viewport.
                let bounds = role_bounds_for_content(content_metrics, &role.rect);
                let base_zoom_factor = role.zoom_factor.clamp(0.25, 3.0);
                let webview = self.with_native_creation_lane(&target.window_id, || {
                    self.add_child_bounded(
                        &window,
                        builder,
                        LogicalPosition::new(bounds.x, bounds.y),
                        LogicalSize::new(bounds.width, bounds.height),
                        &role_id,
                    )
                })?;
                if !first_surface_recorded {
                    first_surface_recorded = true;
                    self.record_runtime_stage(
                        format!("controller-created:{}", tab.tab_id),
                        "completed",
                        launch_started,
                    );
                }
                // Controller visibility belongs to presentation, not native
                // setup or navigation readiness. Show the selected tab's blank
                // viewport immediately; a tab that was switched away from while
                // creation was in flight stays hidden.
                let selected_before_setup = self
                    .presentation
                    .existing(&target.window_id)
                    .and_then(|presentation| {
                        presentation.lock().ok().map(|presentation| {
                            presentation.selected_tab_id.as_deref() == Some(tab.tab_id.as_str())
                        })
                    })
                    .unwrap_or(false);
                let visibility_result = if selected_before_setup {
                    webview.show()
                } else {
                    webview.hide()
                };
                if let Err(error) = visibility_result {
                    return Err(RuntimeError::tauri(error));
                }
                self.record_runtime_stage(
                    format!("controller-presented:{role_id}"),
                    "completed",
                    launch_started,
                );
                created_surfaces.push((role_id.clone(), webview.clone(), None, None));
                let setup_started = Instant::now();
                let setup_stage = format!("native-role-setup:{role_id}");
                self.record_runtime_stage(&setup_stage, "started", setup_started);
                let lifecycle = match self.setup_role_surface(&webview, &role_id, generation) {
                    Ok(lifecycle) => {
                        self.record_runtime_stage(&setup_stage, "completed", setup_started);
                        self.record_runtime_stage(
                            format!("native-setup-completed:{role_id}"),
                            "completed",
                            launch_started,
                        );
                        lifecycle
                    }
                    Err(failure) => {
                        if let Some(lifecycle) = failure.lifecycle {
                            created_surfaces
                                .last_mut()
                                .expect("role surface was just recorded")
                                .2 = Some(lifecycle);
                        }
                        self.record_runtime_stage_failure(
                            &setup_stage,
                            setup_started,
                            &failure.error,
                        );
                        return Err(failure.error);
                    }
                };
                created_surfaces
                    .last_mut()
                    .expect("role surface was just recorded")
                    .2 = Some(Arc::clone(&lifecycle));
                let surface_instance_id = self.register_managed_surface(
                    &webview,
                    &lifecycle,
                    ManagedSurfaceKind::Role,
                    ManagedSurfacePhase::Live,
                    Some(&role_id),
                    Some(&tab.tab_id),
                    &target.window_id,
                    generation,
                )?;
                created_surfaces
                    .last_mut()
                    .expect("role surface was just registered")
                    .3 = Some(surface_instance_id.clone());
                {
                    let mut state = self.state()?;
                    state.role_tabs.insert(role_id.clone(), tab.tab_id.clone());
                    let runtime_tab = state.tabs.get_mut(&tab.tab_id).ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                            "The provisional runtime tab disappeared before attachment completed.",
                        )
                    })?;
                    runtime_tab.roles.insert(
                        role_id.clone(),
                        RoleSurface {
                            current_url: None,
                            generation,
                            high_refresh_rate_status,
                            lifecycle: Arc::clone(&lifecycle),
                            local_storage_sync: sync_config,
                            local_storage_sync_sequence: 0,
                            navigation: Arc::clone(&navigation),
                            rect: role.rect.clone(),
                            surface_instance_id: surface_instance_id.clone(),
                            webview: webview.clone(),
                            zoom_factor: base_zoom_factor,
                            zoom_mode: role.zoom_mode.clone(),
                        },
                    );
                }
                self.set_role_input_surface(&role_id, generation, true, true)?;
                let selected = self
                    .presentation
                    .existing(&target.window_id)
                    .and_then(|presentation| {
                        presentation.lock().ok().map(|mut presentation| {
                            let bound = presentation.bind_surface(
                                &tab.tab_id,
                                SurfacePresentationBinding {
                                    generation,
                                    instance_id: surface_instance_id.clone(),
                                    webview: webview.clone(),
                                },
                            );
                            (
                                bound,
                                presentation.selected_tab_id.as_deref()
                                    == Some(tab.tab_id.as_str()),
                            )
                        })
                    })
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                            "The runtime tab presentation disappeared before surface binding.",
                        )
                    })?;
                if !selected.0 {
                    return Err(RuntimeError::new(
                        "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                        "The runtime tab was removed before its native surface could bind.",
                    ));
                }
                self.presentation
                    .assign_surface_owner(webview.label(), &surface_instance_id, &target.window_id)
                    .map_err(|message| {
                        RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                    })?;
                self.record_runtime_stage(
                    format!("surface-bound:{}:{role_id}", tab.tab_id),
                    "completed",
                    launch_started,
                );
                if selected.1 {
                    let _ = self.request_tab_presentation(
                        &tab.tab_id,
                        NativePresentationFocus::None,
                        "surface-attached",
                    );
                } else {
                    webview.hide().map_err(RuntimeError::tauri)?;
                }
                webview
                    .set_zoom(effective_zoom_factor(base_zoom_factor, window_zoom_factor))
                    .map_err(RuntimeError::tauri)?;
                let url = checked_web_url(&role.role.launch_url)?;
                let navigation_allowed = {
                    let state = self.state()?;
                    !state.close_coordinator.closing_roles.contains(&role_id)
                        && !state.close_coordinator.quarantined_roles.contains(&role_id)
                        && state
                            .tabs
                            .get(&tab.tab_id)
                            .is_some_and(|runtime_tab| runtime_tab.roles.contains_key(&role_id))
                };
                if !navigation_allowed {
                    return Err(RuntimeError::new(
                        "LAUNCH_CANCELLED",
                        "The provisional runtime tab closed before game navigation began.",
                    ));
                }
                let controlled_label = webview.label().to_owned();
                self.begin_controlled_navigation(&controlled_label)?;
                navigation.reset();
                if let Ok(mut state) = self.state()
                    && let Some(role_surface) = state
                        .tabs
                        .get_mut(&tab.tab_id)
                        .and_then(|runtime_tab| runtime_tab.roles.get_mut(&role_id))
                {
                    role_surface.current_url = Some(url.clone());
                }
                webview.navigate(url).map_err(RuntimeError::tauri)?;
                if !first_navigation_recorded {
                    first_navigation_recorded = true;
                    self.record_runtime_stage(
                        format!("navigation-requested:{}", tab.tab_id),
                        "completed",
                        launch_started,
                    );
                }
            }
            self.record_runtime_stage(
                format!("all-surfaces-attached:{}", tab.tab_id),
                "completed",
                launch_started,
            );
            let (resolved_role_bounds, _resolved_dividers) = self.resolve_runtime_layout(
                content_metrics,
                role_inputs,
                tab.workspace_appearance.gap,
            )?;
            for role in &tab.roles {
                let Some(bounds) = resolved_role_bounds.get(&role.role.id).copied() else {
                    continue;
                };
                let (webview, current_zoom_factor, adaptive) = {
                    let state = self.state()?;
                    let surface = state
                        .tabs
                        .get(&tab.tab_id)
                        .and_then(|runtime_tab| runtime_tab.roles.get(&role.role.id))
                        .ok_or_else(|| {
                            RuntimeError::new(
                                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                                "Runtime role was not found after native attachment.",
                            )
                        })?;
                    (
                        surface.webview.clone(),
                        surface.zoom_factor,
                        surface.zoom_mode == "adaptive",
                    )
                };
                let base_zoom_factor = if adaptive {
                    self.adaptive_zoom_factor(bounds.width, Some(current_zoom_factor))?
                } else {
                    current_zoom_factor
                };
                if adaptive
                    && let Ok(mut state) = self.state()
                    && let Some(surface) = state
                        .tabs
                        .get_mut(&tab.tab_id)
                        .and_then(|runtime_tab| runtime_tab.roles.get_mut(&role.role.id))
                {
                    surface.zoom_factor = base_zoom_factor;
                }
                webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .and_then(|()| webview.set_size(LogicalSize::new(bounds.width, bounds.height)))
                    .and_then(|()| {
                        webview
                            .set_zoom(effective_zoom_factor(base_zoom_factor, window_zoom_factor))
                    })
                    .map_err(RuntimeError::tauri)?;
            }
            self.finish_surface_host_initialization(&window, host_created, &target.window_id)?;
            self.set_launch_phase(&tab.tab_id, LaunchPhase::Navigating);
            Ok(())
        })();
        if result.is_err() {
            let failed_launch_diagnostic = result
                .as_ref()
                .err()
                .and_then(|error| error.diagnostic.clone());
            if let Some(presentation) = self.presentation.existing(&target.window_id)
                && let Ok(mut presentation) = presentation.lock()
            {
                presentation.update_phase(&created_tab_id, TabPresentationPhase::Failed);
            }
            let controlled_labels = created_surfaces
                .iter()
                .map(|(_, webview, _, _)| webview.label().to_owned())
                .collect::<Vec<_>>();
            self.finish_controlled_navigations(&controlled_labels);
            let failed_role_ids = tab
                .roles
                .iter()
                .map(|role| role.role.id.clone())
                .collect::<Vec<_>>();
            let mut cleanup_error = None;
            for (surface_id, webview, lifecycle, instance_id) in created_surfaces {
                let cleanup = if let Some(instance_id) = instance_id {
                    self.close_managed_surface_and_wait(&instance_id, &surface_id)
                } else if let Some(lifecycle) = lifecycle {
                    if cfg!(windows) {
                        self.close_failed_launch_surface_and_wait(&webview, &lifecycle, &surface_id)
                    } else {
                        self.close_surface_and_wait(&webview, &lifecycle, &surface_id)
                            .map(|_| ())
                    }
                } else {
                    let close_message = webview.close().err().map(|error| error.to_string());
                    if cfg!(windows) {
                        Err(RuntimeError::new(
                            "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                            close_message.map_or_else(
                                || {
                                    "The failed WebView2 controller closed without a lifecycle tracker, so release could not be verified. Restart Rion Studio before retrying."
                                        .to_owned()
                                },
                                |message| {
                                    format!(
                                        "The failed WebView2 controller could not be closed or verified: {message}. Restart Rion Studio before retrying."
                                    )
                                },
                            ),
                        ))
                    } else {
                        Ok(())
                    }
                };
                if let Err(error) = cleanup {
                    cleanup_error.get_or_insert(error);
                }
            }
            if let Ok(mut state) = self.state.lock() {
                state.tabs.remove(&created_tab_id);
                state.launch_phases.remove(&created_tab_id);
                state
                    .role_tabs
                    .retain(|_, tab_id| tab_id != &created_tab_id);
                if cleanup_error.is_none() {
                    state
                        .completed_failed_launch_cleanups
                        .retain(|_, completed_at| {
                            completed_at.elapsed() <= FAILED_LAUNCH_CLEANUP_RETENTION
                        });
                    state
                        .completed_failed_launch_cleanups
                        .insert(created_tab_id.clone(), Instant::now());
                } else {
                    state.recovery_required = true;
                    state
                        .close_coordinator
                        .quarantined_roles
                        .extend(failed_role_ids);
                }
                if let Some(diagnostic) = failed_launch_diagnostic {
                    state
                        .failed_launch_diagnostics
                        .insert(created_tab_id.clone(), diagnostic);
                }
                if let Some(preview) = launch_preview.as_ref() {
                    state.provisional_launches.insert(
                        format!("{tab_type}:{}", tab.source_id),
                        ProvisionalLaunch {
                            cancelled: false,
                            failed: true,
                            host_created: preview.host_created,
                            id: created_tab_id.clone(),
                            source_id: tab.source_id.clone(),
                            tab_type: tab_type.to_owned(),
                            window_id: target.window_id.clone(),
                        },
                    );
                }
            }
            if let Some(error) = cleanup_error {
                self.health.mark_unhealthy();
                result = Err(error);
            }
            if launch_preview.is_none() {
                let mut next_tab_id = None;
                if let Some(presentation) = self.presentation.existing(&target.window_id)
                    && let Ok(mut selection) = presentation.lock()
                {
                    let was_selected =
                        selection.selected_tab_id.as_deref() == Some(created_tab_id.as_str());
                    let revision = self.presentation.next_revision();
                    selection.remove_tab(&created_tab_id, revision);
                    if was_selected {
                        let successor = selection.tabs.last().map(|tab| tab.id.clone());
                        selection.select(successor, revision);
                    }
                    next_tab_id = selection.selected_tab_id.clone();
                }
                if let Some(next_tab_id) = next_tab_id.as_deref() {
                    let _ = self.request_tab_presentation(
                        next_tab_id,
                        NativePresentationFocus::None,
                        "launch-failed",
                    );
                }
                self.remove_native_tab_reservation(
                    &target.window_id,
                    &created_tab_id,
                    next_tab_id.as_deref(),
                );
                self.remove_empty_display_host(&target.window_id, host_created);
            }
            self.publish_launcher_presence();
        } else {
            let remains_selected =
                self.presentation
                    .existing(&target.window_id)
                    .is_some_and(|presentation| {
                        presentation.lock().ok().is_some_and(|window| {
                            window.selected_tab_id.as_deref() == Some(created_tab_id.as_str())
                        })
                    });
            if remains_selected {
                let _ = self.request_tab_presentation(
                    &created_tab_id,
                    NativePresentationFocus::None,
                    "surface-attached",
                );
            }
        }
        result
    }

}
