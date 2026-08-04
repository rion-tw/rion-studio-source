impl SystemRuntimeExecutor {
    fn claim_role_slot_surface(
        &self,
        tab_id: &str,
        slot: EmbeddedRoleSlotEffectRecord,
        role: rion_core::EmbeddedRoleViewEffectRecord,
    ) -> RuntimeResult<()> {
        if role.role.id != slot.role.id || !is_current_system_engine(role.resolved_engine) {
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_ROLE_SLOT_INVALID",
                "The claimed role slot does not match the resolved System WebView role.",
            ));
        }
        let owner_generation = slot
            .owner
            .as_ref()
            .filter(|owner| owner.tab_id == tab_id && owner.slot_id == slot.slot_id)
            .map(|owner| owner.generation)
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_ROLE_SLOT_INVALID",
                    "The claimed role slot has no matching runtime owner.",
                )
            })?;
        let (window, window_id, selected, window_zoom_factor, previous_owner_generation) = {
            let state = self.state()?;
            if state.role_tabs.contains_key(&role.role.id)
                || state.close_coordinator.closing_roles.contains(&role.role.id)
                || state.close_coordinator.quarantined_roles.contains(&role.role.id)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "The previous native role surface has not been fully released.",
                ));
            }
            let runtime_tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let runtime_slot = runtime_tab.slots.get(&slot.slot_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_ROLE_SLOT_NOT_FOUND",
                    "Runtime role slot was not found.",
                )
            })?;
            if runtime_slot.role.id != role.role.id || runtime_slot.placeholder.is_none() {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_ROLE_SLOT_STALE",
                    "The target role slot changed before native attachment.",
                ));
            }
            let host = state.display_hosts.get(&runtime_tab.window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
            let selected = self
                .presentation
                .existing(&runtime_tab.window_id)
                .and_then(|presentation| {
                    presentation.lock().ok().map(|presentation| {
                        presentation.selected_tab_id.as_deref() == Some(tab_id)
                    })
                })
                .unwrap_or(false);
            (
                host.window.clone(),
                runtime_tab.window_id.clone(),
                selected,
                host.zoom_factor,
                runtime_slot.owner_generation,
            )
        };

        let native_generation = self.claim_surface_generation(&role.role.id)?;
        let navigation = Arc::new(NavigationTracker::default());
        let callback_navigation = Arc::clone(&navigation);
        let navigation_app = self.app.clone();
        let paths = role_session_paths(&self.user_data_dir, &role.role.id)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let label = runtime_label(
            "game-role",
            &format!("{}:generation-{native_generation}", role.role.id),
        );
        let (builder, high_refresh_rate_status) =
            self.role_webview_builder(label, &paths, &role.role.id)?;
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
        let metrics = runtime_window_content_metrics(&window)?;
        let bounds = role_bounds_for_content(metrics, &slot.rect);
        let webview = self.with_native_creation_lane(&window_id, || {
            self.add_child_bounded(
                &window,
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
                &role.role.id,
            )
        })?;
        let mut lifecycle = None;
        let mut surface_instance_id = None;
        let result = (|| -> RuntimeResult<()> {
            if selected {
                webview.show().map_err(RuntimeError::tauri)?;
            } else {
                webview.hide().map_err(RuntimeError::tauri)?;
            }
            let installed_lifecycle = self
                .setup_role_surface(&webview, &role.role.id, native_generation)
                .map_err(|failure| failure.error)?;
            lifecycle = Some(Arc::clone(&installed_lifecycle));
            let instance_id = self.register_managed_surface(
                &webview,
                &installed_lifecycle,
                ManagedSurfaceKind::Role,
                ManagedSurfacePhase::Live,
                Some(&role.role.id),
                Some(tab_id),
                &window_id,
                native_generation,
            )?;
            surface_instance_id = Some(instance_id.clone());
            {
                let mut state = self.state()?;
                if state.role_tabs.contains_key(&role.role.id) {
                    return Err(RuntimeError::new(
                        "SYSTEM_RUNTIME_ROLE_SLOT_STALE",
                        "Another native role surface was attached first.",
                    ));
                }
                let runtime_tab = state.tabs.get_mut(tab_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_TAB_NOT_FOUND",
                        "Runtime tab closed before native attachment committed.",
                    )
                })?;
                let runtime_slot = runtime_tab.slots.get_mut(&slot.slot_id).ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_ROLE_SLOT_NOT_FOUND",
                        "Runtime role slot closed before native attachment committed.",
                    )
                })?;
                if runtime_slot.role.id != role.role.id || runtime_slot.placeholder.is_none() {
                    return Err(RuntimeError::new(
                        "SYSTEM_RUNTIME_ROLE_SLOT_STALE",
                        "Runtime role slot changed before native attachment committed.",
                    ));
                }
                runtime_slot.owner_generation = Some(owner_generation);
                runtime_tab.roles.insert(
                    role.role.id.clone(),
                    RoleSurface {
                        current_url: None,
                        generation: native_generation,
                        high_refresh_rate_status,
                        lifecycle: Arc::clone(&installed_lifecycle),
                        navigation: Arc::clone(&navigation),
                        rect: role.rect.clone(),
                        surface_instance_id: instance_id.clone(),
                        webview: webview.clone(),
                        zoom_factor: role.zoom_factor.clamp(0.25, 3.0),
                        zoom_mode: role.zoom_mode.clone(),
                    },
                );
                state.role_tabs.insert(role.role.id.clone(), tab_id.to_owned());
            }
            self.set_role_input_surface(&role.role.id, native_generation, true, true)?;
            let bound = self
                .presentation
                .existing(&window_id)
                .and_then(|presentation| {
                    presentation.lock().ok().map(|mut presentation| {
                        presentation.bind_surface(
                            tab_id,
                            SurfacePresentationBinding {
                                generation: native_generation,
                                instance_id: instance_id.clone(),
                                webview: webview.clone(),
                            },
                        )
                    })
                })
                .unwrap_or(false);
            if !bound {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                    "Runtime tab closed before its claimed role surface could bind.",
                ));
            }
            self.presentation
                .assign_surface_owner(webview.label(), &instance_id, &window_id)
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                })?;
            webview
                .set_zoom(effective_zoom_factor(
                    role.zoom_factor.clamp(0.25, 3.0),
                    window_zoom_factor,
                ))
                .map_err(RuntimeError::tauri)?;
            self.layout_runtime_tab_inner(tab_id)
        })();
        if let Err(error) = result {
            if let Ok(mut state) = self.state.lock()
                && state.role_tabs.get(&role.role.id).map(String::as_str) == Some(tab_id)
            {
                state.role_tabs.remove(&role.role.id);
                if let Some(runtime_tab) = state.tabs.get_mut(tab_id) {
                    runtime_tab.roles.remove(&role.role.id);
                    if let Some(runtime_slot) = runtime_tab.slots.get_mut(&slot.slot_id) {
                        runtime_slot.owner_generation = previous_owner_generation;
                    }
                }
            }
            if let Some(instance_id) = surface_instance_id {
                let _ = self.close_managed_surface_and_wait(&instance_id, &role.role.id);
            } else if let Some(lifecycle) = lifecycle {
                let _ = self.close_surface_and_wait(&webview, &lifecycle, &role.role.id);
            } else {
                let _ = webview.close();
            }
            return Err(error);
        }
        Ok(())
    }

    fn finish_claimed_role_slot(&self, role_id: &str) -> RuntimeResult<()> {
        let owner = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Claimed runtime role was not found.",
                )
            })?;
            let tab = state.tabs.get(&tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let slot = tab
                .slots
                .values()
                .find(|slot| slot.role.id == role_id)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_ROLE_SLOT_NOT_FOUND",
                        "Claimed runtime role slot was not found.",
                    )
                })?;
            BrowserRuntimeRoleOwnerRecord {
                generation: slot.owner_generation.unwrap_or(0),
                slot_id: slot.slot_id.clone(),
                tab_id,
                window_id: tab.window_id.clone(),
            }
        };
        self.refresh_role_placeholders(role_id, Some(owner))
    }

    fn refresh_role_placeholders(
        &self,
        role_id: &str,
        owner: Option<BrowserRuntimeRoleOwnerRecord>,
    ) -> RuntimeResult<()> {
        let placeholders = {
            let state = self.state()?;
            state
                .tabs
                .iter()
                .filter_map(|(tab_id, tab)| {
                    let slot = tab.slots.values().find(|slot| slot.role.id == role_id)?;
                    let placeholder = slot.placeholder.as_ref()?;
                    let window = state.display_hosts.get(&tab.window_id)?.window.clone();
                    Some((
                        tab_id.clone(),
                        tab.window_id.clone(),
                        window,
                        EmbeddedRoleSlotEffectRecord {
                            owner: owner.clone(),
                            rect: slot.rect.clone(),
                            role: slot.role.clone(),
                            slot_id: slot.slot_id.clone(),
                            state: owner.as_ref().map_or_else(
                                || "available".to_owned(),
                                |owner| {
                                    if tab_id.as_str() == owner.tab_id {
                                        "running".to_owned()
                                    } else {
                                        "blocked".to_owned()
                                    }
                                },
                            ),
                            zoom_factor: slot.zoom_factor,
                            zoom_mode: slot.zoom_mode.clone(),
                        },
                        RolePlaceholderSurface {
                            surface_instance_id: placeholder.surface_instance_id.clone(),
                            webview: placeholder.webview.clone(),
                        },
                    ))
                })
                .collect::<Vec<_>>()
        };
        for (tab_id, window_id, window, slot, placeholder) in placeholders {
            self.close_role_placeholder_surface(placeholder)?;
            {
                let mut state = self.state()?;
                if let Some(runtime_slot) = state
                    .tabs
                    .get_mut(&tab_id)
                    .and_then(|tab| tab.slots.get_mut(&slot.slot_id))
                {
                    runtime_slot.placeholder = None;
                    runtime_slot.owner_generation =
                        owner.as_ref().map(|owner| owner.generation);
                }
            }
            if owner
                .as_ref()
                .is_some_and(|owner| tab_id.as_str() == owner.tab_id)
            {
                continue;
            }
            let selected = self
                .presentation
                .existing(&window_id)
                .and_then(|presentation| {
                    presentation.lock().ok().map(|presentation| {
                        presentation.selected_tab_id.as_deref() == Some(tab_id.as_str())
                    })
                })
                .unwrap_or(false);
            let metrics = runtime_window_content_metrics(&window)?;
            let bounds = role_bounds_for_content(metrics, &slot.rect);
            let replacement = self.create_role_placeholder(
                &window,
                &window_id,
                &tab_id,
                &slot,
                bounds,
                selected,
            )?;
            let mut state = self.state()?;
            let runtime_slot = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.slots.get_mut(&slot.slot_id))
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_ROLE_SLOT_STALE",
                        "Role slot closed while its placeholder was refreshed.",
                    )
                })?;
            runtime_slot.placeholder = Some(replacement);
        }
        Ok(())
    }
}
