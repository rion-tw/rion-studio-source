impl SystemRuntimeExecutor {
    fn rebuild_role_surface(
        &self,
        transaction: &SurfaceRecoveryTransaction,
        destructive_started: &mut bool,
    ) -> RuntimeResult<()> {
        let role_id = transaction.role_id.as_str();
        {
            let state = self.state()?;
            if state.close_coordinator.closing_roles.contains(role_id)
                || state.close_coordinator.quarantined_roles.contains(role_id)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "The role is closing or quarantined and cannot be recovered until Rion Studio restarts.",
                ));
            }
        }
        let (
            tab_id,
            window_id,
            window,
            old_surface_instance_id,
            old_webview_label,
            expected_generation,
            rect,
            current_url,
            zoom_factor,
            zoom_mode,
            window_zoom_factor,
            audio_muted,
            generation,
        ) = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found during System WebView recovery.",
                )
            })?;
            let (
                window_id,
                old_surface_instance_id,
                old_webview_label,
                expected_generation,
                rect,
                current_url,
                zoom_factor,
                zoom_mode,
                audio_muted,
            ) = {
                let tab = state.tabs.get(&tab_id).ok_or_else(|| {
                    RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
                })?;
                let role = tab.roles.get(role_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role surface was not found during recovery.",
                    )
                })?;
                if !surface_recovery_target_is_current(
                    &tab.window_id,
                    &transaction.window_id,
                    role.generation,
                    transaction.surface_generation,
                ) {
                    return Err(RuntimeError::new(
                        "SYSTEM_SURFACE_RECOVERY_STALE",
                        "A newer System WebView surface superseded this recovery attempt.",
                    ));
                }
                let current_url = role.current_url.clone().ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_RECOVERY_URL_MISSING",
                        "The crashed System WebView has no recoverable URL.",
                    )
                })?;
                (
                    tab.window_id.clone(),
                    role.surface_instance_id.clone(),
                    role.webview.label().to_owned(),
                    role.generation,
                    role.rect.clone(),
                    current_url,
                    role.zoom_factor,
                    role.zoom_mode.clone(),
                    tab.audio_muted,
                )
            };
            let host = state.display_hosts.get(&window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found during recovery.",
                )
            })?;
            let window = host.window.clone();
            let window_zoom_factor = host.zoom_factor;
            let generation = state
                .recovery_generations
                .get(role_id)
                .copied()
                .unwrap_or(expected_generation)
                .max(expected_generation)
                .saturating_add(1);
            (
                tab_id,
                window_id,
                window,
                old_surface_instance_id,
                old_webview_label,
                expected_generation,
                rect,
                current_url,
                zoom_factor,
                zoom_mode,
                window_zoom_factor,
                audio_muted,
                generation,
            )
        };
        self.update_surface_recovery_phase(transaction, "rebuilding");
        let navigation = Arc::new(NavigationTracker::default());
        let callback_navigation = Arc::clone(&navigation);
        let navigation_app = self.app.clone();
        let navigation_label = format!(
            "{}-recovery-{generation}",
            runtime_label("game-role", role_id)
        );
        let paths = role_session_paths(&self.user_data_dir, role_id)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let (builder, high_refresh_rate_status) = self.role_webview_builder(
            navigation_label.clone(),
            &paths,
            role_id,
        )?;
        let builder = builder.on_page_load(move |webview, payload| {
            callback_navigation.page_event(payload.event(), payload.url());
            if payload.event() == PageLoadEvent::Finished
                && let Some(state) = navigation_app.try_state::<crate::CoreState>()
            {
                state
                    .runtime
                    .finish_main_frame_navigation_page(&webview, payload.url());
            }
        });
        let bounds = role_bounds_for_content(runtime_window_content_metrics(&window)?, &rect);
        let webview = self.add_child_bounded(
            &window,
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
            role_id,
        )?;
        let lifecycle = match self.install_surface_lifecycle_tracker(&webview) {
            Ok(lifecycle) => lifecycle,
            Err(error) => {
                let _ = webview.close();
                return Err(error);
            }
        };
        let replacement_instance_id = match self.register_managed_surface(
            &webview,
            &lifecycle,
            ManagedSurfaceKind::Recovery,
            ManagedSurfacePhase::Provisional,
            Some(role_id),
            Some(&tab_id),
            &window_id,
            generation,
        ) {
            Ok(instance_id) => instance_id,
            Err(error) => {
                let _ = webview.close();
                return Err(error);
            }
        };
        let preparation = (|| -> RuntimeResult<()> {
            // The replacement remains about:blank until the old native surface is gone.
            webview.hide().map_err(RuntimeError::tauri)?;
            install_platform_security_policy(&webview)?;
            install_role_zoom_shortcut_handler(&webview, self.app.clone())?;
            install_process_failure_monitor(
                &webview,
                self.app.clone(),
                SurfaceFailureTarget::Role {
                    role_id: role_id.to_owned(),
                    generation,
                },
            )?;
            webview
                .set_zoom(effective_zoom_factor(zoom_factor, window_zoom_factor))
                .map_err(RuntimeError::tauri)?;
            Ok(())
        })();
        if let Err(error) = preparation {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }
        let replacement_label = webview.label().to_owned();
        let popup_labels = (|| -> RuntimeResult<Vec<String>> {
            let state = self.state()?;
            let active_tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role stopped while its System WebView was recovering.",
                )
            })?;
            let active_surface = state
                .tabs
                .get(active_tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role stopped while its System WebView was recovering.",
                    )
                })?;
            if active_tab_id != &tab_id
                || active_surface.surface_instance_id != old_surface_instance_id
                || !surface_recovery_swap_is_current(
                    active_surface.webview.label(),
                    &old_webview_label,
                    active_surface.generation,
                    expected_generation,
                )
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RECOVERY_STALE",
                    "A newer System WebView surface superseded this recovery attempt.",
                ));
            }
            Ok(state
                .popup_roles
                .iter()
                .filter(|(_, popup_role_id)| *popup_role_id == role_id)
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>())
        })();
        let popup_labels = match popup_labels {
            Ok(labels) => labels,
            Err(error) => {
                let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
                return Err(error);
            }
        };

        self.update_surface_recovery_phase(transaction, "isolating");
        for label in popup_labels {
            if let Err(error) = self.close_popup_and_wait(&label, role_id) {
                let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
                return Err(error);
            }
            self.forget_popup(&label);
        }

        *destructive_started = true;
        if let Err(error) =
            self.set_managed_surface_phase(&old_surface_instance_id, ManagedSurfacePhase::Retired)
        {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }
        let old_close = self.close_managed_surface_and_wait(&old_surface_instance_id, role_id);
        if let Err(error) = old_close {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }

        self.update_surface_recovery_phase(transaction, "navigating");
        let controlled_label = replacement_label.clone();
        let replacement_surface = self.managed_surface(&replacement_instance_id)?;
        let navigation_start = (|| -> RuntimeResult<()> {
            let _native_lifecycle_guard = replacement_surface
                .native_lifecycle_lane
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_LIFECYCLE_UNAVAILABLE",
                        "The native surface lifecycle lane is unavailable.",
                    )
                })?;
            let close_fenced = {
                let state = self.state()?;
                state.close_coordinator.closing_roles.contains(role_id)
                    || state.close_coordinator.quarantined_roles.contains(role_id)
                    || state
                        .surface_registry
                        .get(&replacement_instance_id)
                        .is_none_or(|surface| surface.phase != ManagedSurfacePhase::Provisional)
            };
            if close_fenced {
                Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RECOVERY_STALE",
                    "The role began closing before its replacement surface could navigate.",
                ))
            } else {
                self.begin_controlled_navigation(&controlled_label)?;
                navigation.reset();
                webview
                    .navigate(current_url.clone())
                    .map_err(RuntimeError::tauri)
            }
        })();
        let navigation_result = navigation_start.and_then(|()| {
            navigation
                .wait()
                .map_err(|message| RuntimeError::new("SYSTEM_SURFACE_RECOVERY_FAILED", message))
        });
        self.finish_controlled_navigations(&[controlled_label]);
        if let Err(error) = navigation_result {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }
        let presentation_result = (|| -> RuntimeResult<()> {
            let _native_lifecycle_guard = replacement_surface
                .native_lifecycle_lane
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_LIFECYCLE_UNAVAILABLE",
                        "The native surface lifecycle lane is unavailable.",
                    )
                })?;
            let state = self.state()?;
            if state.close_coordinator.closing_roles.contains(role_id)
                || state.close_coordinator.quarantined_roles.contains(role_id)
                || state
                    .surface_registry
                    .get(&replacement_instance_id)
                    .is_none_or(|surface| surface.phase != ManagedSurfacePhase::Provisional)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RECOVERY_STALE",
                    "The role began closing before its replacement surface could be shown.",
                ));
            }
            drop(state);
            if audio_muted {
                set_audio_muted(&webview, true)?;
            }
            Ok(())
        })();
        if let Err(error) = presentation_result {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }

        self.update_surface_recovery_phase(transaction, "swapping");
        let mut state = self.state()?;
        let active_tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
            RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime role stopped while its System WebView was recovering.",
            )
        })?;
        let active_surface = state
            .tabs
            .get(&active_tab_id)
            .and_then(|tab| tab.roles.get(role_id))
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role stopped while its System WebView was recovering.",
                )
            })?;
        if state.close_coordinator.closing_roles.contains(role_id)
            || state.close_coordinator.quarantined_roles.contains(role_id)
            || active_tab_id != tab_id
            || active_surface.surface_instance_id != old_surface_instance_id
            || !surface_recovery_swap_is_current(
                active_surface.webview.label(),
                &old_webview_label,
                active_surface.generation,
                expected_generation,
            )
        {
            drop(state);
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_RECOVERY_STALE",
                "A newer System WebView surface superseded this recovery attempt.",
            ));
        }
        let replacement_webview = webview.clone();
        state
            .tabs
            .get_mut(&tab_id)
            .expect("the recovery tab was validated above")
            .roles
            .insert(
                role_id.to_owned(),
                RoleSurface {
                    current_url: Some(current_url),
                    generation,
                    high_refresh_rate_status,
                    lifecycle,
                    navigation,
                    rect,
                    surface_instance_id: replacement_instance_id.clone(),
                    webview,
                    zoom_factor,
                    zoom_mode,
                },
            );
        state
            .recovery_generations
            .insert(role_id.to_owned(), generation);
        if let Some(surface) = state.surface_registry.get_mut(&replacement_instance_id) {
            surface.kind = ManagedSurfaceKind::Role;
            surface.phase = ManagedSurfacePhase::Live;
        }
        drop(state);
        self.set_role_input_surface(role_id, generation, false, false)?;
        let surface_bound = self
            .presentation
            .existing(&window_id)
            .and_then(|presentation| {
                presentation.lock().ok().map(|mut presentation| {
                    let bound = presentation.bind_surface(
                        &tab_id,
                        SurfacePresentationBinding {
                            generation,
                            instance_id: replacement_instance_id.clone(),
                            webview: replacement_webview.clone(),
                        },
                    );
                    (
                        bound,
                        presentation.selected_tab_id.as_deref() == Some(tab_id.as_str()),
                    )
                })
            })
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation disappeared before recovery could bind its replacement surface.",
                )
            })?;
        if !surface_bound.0 {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                "The runtime tab closed before recovery could bind its replacement surface.",
            ));
        }
        self.presentation
            .assign_surface_owner(
                replacement_webview.label(),
                &replacement_instance_id,
                &window_id,
            )
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        if surface_bound.1 {
            let _ = self.request_tab_presentation(
                &tab_id,
                NativePresentationFocus::None,
                "surface-recovered",
            );
        } else {
            let _ = replacement_webview.hide();
        }
        if let Ok(surface) = self.managed_surface(&replacement_instance_id) {
            self.record_surface_event(
                LogLevel::Info,
                "surface.recovered",
                "Replacement native surface activated after the old surface was released.",
                &surface,
            );
        }
        Ok(())
    }

}
