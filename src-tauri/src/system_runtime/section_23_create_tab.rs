impl SystemRuntimeExecutor {
    fn create_tab(&self, mut tab: EmbeddedTabEffectRecord) -> RuntimeResult<()> {
        let launch_started = Instant::now();
        let attempt_generation = tab
            .attempt_generation
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
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
        if self.current_window_close_in_progress(&tab.target.window_id) {
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_WINDOW_CLOSING",
                "The native create effect belongs to a window generation that is closing.",
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
        let launch_preview = self.take_tab_launch_preview(
            tab.launch_preview_id.as_deref(),
            &target.window_id,
            &tab.source_id,
            tab_type,
        )?;
        let (window, native_host_created) = self
            .with_native_creation_lane(&target.window_id, || {
                self.ensure_display_host(&target, &tab.name)
            })?;
        let (pending_window_restore, should_select) = self.restored_tab_selection_intent(
            &target.window_id,
            &tab.tab_id,
            launch_preview.as_ref(),
        );
        let host_created = native_host_created
            || launch_preview
                .as_ref()
                .is_some_and(|preview| preview.host_created)
            || pending_window_restore
                .as_ref()
                .is_some_and(|restore| restore.host_created);
        let created_tab_id = tab.tab_id.clone();
        {
            let mut state = self.state()?;
            apply_prepared_role_slots_to_effect(&mut state, &mut tab)?;
            state
                .completed_failed_launch_cleanups
                .retain(|(tab_id, _)| tab_id != &created_tab_id);
            state.retryable_failed_launches.remove(&created_tab_id);
            state
                .launch_attempt_generations
                .insert(created_tab_id.clone(), attempt_generation.clone());
            state.tabs.insert(
                created_tab_id.clone(),
                RuntimeTab {
                    active_divider_resize: None,
                    audio_muted: false,
                    dividers: Vec::new(),
                    roles: HashMap::new(),
                    slots: tab
                        .slots
                        .iter()
                        .map(|slot| {
                            (
                                slot.slot_id.clone(),
                                RuntimeRoleSlot {
                                    owner_generation: slot
                                        .owner
                                        .as_ref()
                                        .map(|owner| owner.generation),
                                    placeholder: None,
                                    rect: slot.rect.clone(),
                                    role: slot.role.clone(),
                                    slot_id: slot.slot_id.clone(),
                                    zoom_factor: slot.zoom_factor.clamp(0.25, 3.0),
                                    zoom_mode: slot.zoom_mode.clone(),
                                },
                            )
                        })
                        .collect(),
                    workspace_id: tab.workspace_id.clone(),
                    workspace_appearance: tab.workspace_appearance.clone(),
                    #[cfg(any(windows, target_os = "macos"))]
                    workspace_template: tab.workspace_template.clone(),
                },
            );
        }
        let presentation = self
            .presentation
            .coordinator(&target.window_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        let (previous_tab_id, previous_surfaces, reservation_revision) = {
            let mut selection = presentation.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?.clone();
            let previous_tab_id = selection.selected_tab_id.clone();
            let previous_surfaces = self
                .presentation
                .surfaces(&target.window_id, previous_tab_id.as_deref());
            let presentation_tab = LiveTabRecord {
                audio_muted: false,
                closable: true,
                icon_data_url: None,
                id: created_tab_id.clone(),
                persistable: true,
                role_ids: tab
                    .slots
                    .iter()
                    .map(|slot| slot.role.id.clone())
                    .collect(),
                role_slots: persisted_role_slots_from_effect(&tab.slots),
                source_id: tab.source_id.clone(),
                tab_type: tab_type.to_owned(),
                title: tab.name.clone(),
                #[cfg(any(windows, target_os = "macos"))]
                workspace_template: tab.workspace_template.clone(),
            };
            if let Some(preview) = launch_preview.as_ref() {
                selection.replace_tab_id(&preview.id, presentation_tab, 0);
                if !should_select
                    && selection.selected_tab_id.as_deref() == Some(created_tab_id.as_str())
                {
                    selection.select(previous_tab_id.clone(), 0);
                }
            } else {
                selection.insert_tab(presentation_tab, 0, should_select);
            }
            if let Some(restore) = pending_window_restore.as_ref() {
                selection.reorder_known_tabs(&restore.ordered_tab_ids);
            }
            if should_select {
                selection.select(Some(created_tab_id.clone()), 0);
            }
            let receipt = self
                .presentation
                .commit_live_window_record(
                    if pending_window_restore.is_some() {
                        "restore"
                    } else {
                        "command"
                    },
                    &target.window_id,
                    &selection,
                )
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            if receipt.status == LiveTopologyCommitStatus::Superseded {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_SUPERSEDED",
                    "A newer live tab intent superseded native tab attachment.",
                ));
            }
            if let Some(preview) = launch_preview.as_ref() {
                if let Some(live) = self.presentation.existing(&target.window_id)
                    && let Ok(mut live) = live.lock()
                {
                    live.aliases.insert(preview.id.clone(), created_tab_id.clone());
                }
                self.presentation.replace_tab_projection(
                    &target.window_id,
                    &preview.id,
                    &created_tab_id,
                );
            }
            (previous_tab_id, previous_surfaces, receipt.revision)
        };
        self.schedule_live_projection_membership_follow();
        self.presentation
            .statuses
            .set_launch_phase(&created_tab_id, LaunchPhase::Attaching);
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
        let native_reservation = self.reserve_native_tab_for_create(
            &tab,
            tab_type,
            reservation_revision,
            active_tab_id.as_deref(),
            launch_preview.as_ref(),
            pending_window_restore.as_ref(),
        );
        if native_reservation.is_ok() {
            self.mark_restored_native_tab_reserved(&target.window_id, &created_tab_id);
        }
        self.reconcile_prepared_restored_window_tabs(&target.window_id)?;
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
            None,
        );
        self.wait_for_presentation_paint_barrier(&target.window_id, reservation_revision);
        let window_zoom_factor = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| host.zoom_factor)
            .unwrap_or(1.0);
        let mut created_surfaces = Vec::new();
        let mut created_placeholders = Vec::new();
        let mut first_surface_recorded = false;
        let mut first_navigation_recorded = false;
        let mut result = (|| -> RuntimeResult<()> {
            let content_metrics = runtime_window_content_metrics(&window)?;
            let role_inputs = tab
                .slots
                .iter()
                .map(embedded_role_slot_input)
                .collect::<Vec<_>>();
            for slot in tab.slots.iter().filter(|slot| {
                !tab.roles
                    .iter()
                    .any(|role| role.role.id == slot.role.id)
            }) {
                let bounds = role_bounds_for_content(content_metrics, &slot.rect);
                let placeholder = self.create_role_placeholder(
                    &window,
                    &target.window_id,
                    &tab.tab_id,
                    slot,
                    bounds,
                    should_select,
                )?;
                let state = match self.state() {
                    Ok(state) => state,
                    Err(error) => {
                        let _ = self.close_role_placeholder_surface(placeholder);
                        return Err(error);
                    }
                };
                let attached = {
                    let mut state = state;
                    state
                        .tabs
                        .get_mut(&tab.tab_id)
                        .and_then(|runtime_tab| runtime_tab.slots.get_mut(&slot.slot_id))
                        .map(|runtime_slot| {
                            runtime_slot.placeholder = Some(RolePlaceholderSurface {
                                surface_instance_id: placeholder.surface_instance_id.clone(),
                                webview: placeholder.webview.clone(),
                            });
                        })
                        .is_some()
                };
                if !attached {
                    self.close_role_placeholder_surface(placeholder)?;
                    return Err(RuntimeError::new(
                        "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                        "The runtime role slot disappeared before its placeholder attached.",
                    ));
                }
                created_placeholders.push((slot.slot_id.clone(), placeholder));
            }
            for role in &tab.roles {
                let role_id = role.role.id.clone();
                let generation = self.claim_surface_generation(&role_id)?;
                let navigation = Arc::new(NavigationTracker::default());
                let callback_navigation = Arc::clone(&navigation);
                let role_label =
                    runtime_label("game-role", &format!("{role_id}:generation-{generation}"));
                let navigation_app = self.app.clone();
                let paths = role_session_paths(&self.user_data_dir, &role_id)?;
                fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
                let (builder, high_refresh_rate_status) =
                    self.role_webview_builder(role_label, &paths, &role_id)?;
                let builder = builder.on_page_load(move |webview, payload| {
                    callback_navigation.page_event(payload.event(), payload.url());
                    if payload.event() == PageLoadEvent::Finished
                        && let Some(state) = navigation_app.try_state::<crate::CoreState>()
                    {
                        state
                            .runtime
                            .finish_main_frame_navigation_page(&webview, payload.url());
                        state.runtime.schedule_ready_surface_viewport_refresh(&webview);
                    }
                });
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
                        presentation.lock().ok().map(|presentation| {
                            presentation.selected_tab_id.as_deref()
                                == Some(tab.tab_id.as_str())
                        })
                    })
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                            "The runtime tab presentation disappeared before surface binding.",
                        )
                    })?;
                let bound = self.presentation.bind_surface(
                    &target.window_id,
                    &tab.tab_id,
                    SurfacePresentationBinding {
                        generation,
                        instance_id: surface_instance_id.clone(),
                        webview: webview.clone(),
                    },
                );
                if !bound {
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
                if selected {
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
            for slot in &tab.slots {
                let Some(bounds) = resolved_role_bounds.get(&slot.role.id).copied() else {
                    continue;
                };
                let surface = {
                    let state = self.state()?;
                    let runtime_tab = state.tabs.get(&tab.tab_id).ok_or_else(|| {
                        RuntimeError::new(
                            "TAURI_RUNTIME_TAB_NOT_FOUND",
                            "Runtime tab was not found after native attachment.",
                        )
                    })?;
                    if let Some(surface) = runtime_tab.roles.get(&slot.role.id) {
                        Some((
                            surface.webview.clone(),
                            surface.zoom_factor,
                            surface.zoom_mode == "adaptive",
                        ))
                    } else {
                        runtime_tab
                            .slots
                            .get(&slot.slot_id)
                            .and_then(|runtime_slot| runtime_slot.placeholder.as_ref())
                            .map(|placeholder| {
                                (
                                    placeholder.webview.clone(),
                                    slot.zoom_factor.clamp(0.25, 3.0),
                                    false,
                                )
                            })
                    }
                };
                let Some((webview, current_zoom_factor, adaptive)) = surface else {
                    return Err(RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role slot was not found after native attachment.",
                    ));
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
                        .and_then(|runtime_tab| runtime_tab.roles.get_mut(&slot.role.id))
                {
                    surface.zoom_factor = base_zoom_factor;
                }
                webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .and_then(|()| webview.set_size(LogicalSize::new(bounds.width, bounds.height)))
                    .and_then(|()| {
                        if adaptive {
                            webview.set_zoom(effective_zoom_factor(
                                base_zoom_factor,
                                window_zoom_factor,
                            ))
                        } else {
                            Ok(())
                        }
                    })
                    .map_err(RuntimeError::tauri)?;
            }
            self.finish_surface_host_initialization(
                &window,
                surface_host_initialization_should_restore_hidden(
                    host_created,
                    Some(launch_preview.is_some()),
                ),
                &target.window_id,
            )?;
            self.set_launch_phase(&tab.tab_id, LaunchPhase::Navigating);
            Ok(())
        })();
        self.finish_restored_tab_creation(&target.window_id, &created_tab_id, result.is_ok());
        if result.is_err() {
            let failed_launch_diagnostic = result
                .as_ref()
                .err()
                .and_then(|error| error.diagnostic.clone());
            let attempt_was_current = self.state.lock().ok().is_some_and(|state| {
                state.launch_attempt_generations.get(&created_tab_id)
                    == Some(&attempt_generation)
            });
            if attempt_was_current {
                self.presentation
                    .statuses
                    .set_presentation_phase(&created_tab_id, TabRuntimePhase::Failed);
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
                    if cfg!(windows) {
                        self.close_untracked_failed_launch_surface_and_wait(&webview, &surface_id)
                    } else {
                        let _ = webview.close();
                        Ok(())
                    }
                };
                if let Err(error) = cleanup {
                    cleanup_error.get_or_insert(error);
                }
            }
            for (_, placeholder) in created_placeholders {
                if let Err(error) = self.close_role_placeholder_surface(placeholder) {
                    cleanup_error.get_or_insert(error);
                }
            }
            let mut completed_tombstone = None;
            if let Ok(mut state) = self.state.lock() {
                let attempt_is_current = state
                    .launch_attempt_generations
                    .get(&created_tab_id)
                    == Some(&attempt_generation);
                if attempt_is_current {
                    state.tabs.remove(&created_tab_id);
                    state
                        .role_tabs
                        .retain(|_, tab_id| tab_id != &created_tab_id);
                }
                if cleanup_error.is_none() && attempt_is_current {
                    // Verified cleanup also completes a concurrent provisional close.
                    completed_tombstone =
                        retire_completed_tab_close_fence(&mut state, &created_tab_id);
                    state
                        .completed_failed_launch_cleanups
                        .insert((created_tab_id.clone(), attempt_generation.clone()));
                    state
                        .retryable_failed_launches
                        .insert(created_tab_id.clone());
                } else if cleanup_error.is_some() {
                    state.recovery_required = true;
                    state
                        .close_coordinator
                        .quarantined_roles
                        .extend(failed_role_ids);
                }
                if attempt_is_current
                    && let Some(diagnostic) = failed_launch_diagnostic
                {
                    state
                        .failed_launch_diagnostics
                        .insert(created_tab_id.clone(), diagnostic);
                }
                if attempt_is_current
                    && let Some(preview) = launch_preview.as_ref()
                {
                    insert_provisional_launch(
                        &mut state,
                        ProvisionalLaunch {
                            cancelled: false,
                            failed: true,
                            host_created: preview.host_created,
                            id: created_tab_id.clone(),
                            launch_preview_id: preview.launch_preview_id.clone(),
                            source_id: tab.source_id.clone(),
                            tab_type: tab_type.to_owned(),
                            window_id: target.window_id.clone(),
                        },
                    );
                }
            }
            if let Some(tombstone) = completed_tombstone.as_ref() {
                self.record_tab_close_tombstone_resolution(&created_tab_id, tombstone, true);
            }
            if let Some(error) = cleanup_error {
                result = Err(error);
            }
            // The live tab and its native chrome reservation intentionally remain.
            // Surface failure is a runtime status/placeholder concern and can never
            // compensate the already committed user-visible topology.
            self.schedule_live_window_state_persistence(&target.window_id);
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
            self.schedule_live_window_state_persistence(&target.window_id);
        }
        result
    }

}
