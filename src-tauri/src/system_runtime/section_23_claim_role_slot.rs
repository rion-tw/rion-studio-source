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
        let window_id = self.resolve_live_tab_window_id(tab_id)?;
        let window_zoom_factor = self.runtime_window_zoom_factor(&window_id);
        let (role_zoom_factor, _) = self.runtime_role_zoom_contract(
            &window_id,
            tab_id,
            &role.role.id,
            role.zoom_factor,
        );
        let (window, window_id, window_zoom_factor, previous_owner_generation) = {
            let state = self.state()?;
            if state.has_native_role_surface(&role.role.id)
                || state.close_coordinator.closing_roles.contains(&role.role.id)
                || state.close_coordinator.quarantined_roles.contains(&role.role.id)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "The previous native role surface has not been fully released.",
                ));
            }
            let runtime_tab = state.native_resources.tabs.get(tab_id).ok_or_else(|| {
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
            let host = state.native_resources.display_hosts.get(&window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
            (
                host.window.clone(),
                window_id.clone(),
                window_zoom_factor,
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
        let (builder, _) =
            self.role_webview_builder(&window, label, &paths, &role.role.id)?;
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
        webview.hide().map_err(RuntimeError::tauri)?;
        let mut lifecycle = None;
        let mut surface_instance_id = None;
        let result = (|| -> RuntimeResult<()> {
            let installed_lifecycle = self
                .setup_role_surface(
                    &webview,
                    &role.role.id,
                    native_generation,
                    Arc::clone(&navigation),
                )
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
                if state.has_native_role_surface(&role.role.id) {
                    return Err(RuntimeError::new(
                        "SYSTEM_RUNTIME_ROLE_SLOT_STALE",
                        "Another native role surface was attached first.",
                    ));
                }
                let runtime_tab = state.native_resources.tabs.get_mut(tab_id).ok_or_else(|| {
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
                        lifecycle: Arc::clone(&installed_lifecycle),
                        navigation: Arc::clone(&navigation),
                        rect: role.rect.clone(),
                        surface_instance_id: instance_id.clone(),
                        webview: webview.clone(),
                        workspace_web: None,
                        zoom_factor: role_zoom_factor,
                    },
                );
            }
            self.input_readiness.notify();
            self.set_role_input_surface(&role.role.id, native_generation, true, true)?;
            let bound = self.presentation.bind_surface(
                &window_id,
                tab_id,
                SurfacePresentationBinding {
                    generation: native_generation,
                    instance_id: instance_id.clone(),
                    webview: webview.clone(),
                },
            );
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
                    role_zoom_factor,
                    window_zoom_factor,
                ))
                .map_err(RuntimeError::tauri)?;
            self.layout_runtime_tab_inner(tab_id)?;
            self.finish_claimed_role_slot(&role.role.id)?;
            self.reconcile_surface_membership(&window_id, "claimed-surface-attached");
            self.record_runtime_stage(
                format!("tab.surfaces-attached:{tab_id}:claim:{}", role.role.id),
                "completed",
                Instant::now(),
            );
            Ok(())
        })();
        if let Err(error) = result {
            if let Ok(mut state) = self.state.lock()
                && state.native_tab_id_for_role_surface(&role.role.id).map(String::as_str) == Some(tab_id)
                && let Some(runtime_tab) = state.native_resources.tabs.get_mut(tab_id)
            {
                runtime_tab.roles.remove(&role.role.id);
                if let Some(runtime_slot) = runtime_tab.slots.get_mut(&slot.slot_id) {
                    runtime_slot.owner_generation = previous_owner_generation;
                }
            }
            self.input_readiness.notify();
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
            let tab_id = state.native_tab_id_for_role_surface(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Claimed runtime role was not found.",
                )
            })?;
            let tab = state.native_resources.tabs.get(&tab_id).ok_or_else(|| {
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
                .native_resources.tabs
                .iter()
                .filter_map(|(tab_id, tab)| {
                    let slot = tab.slots.values().find(|slot| slot.role.id == role_id)?;
                    let placeholder = slot.placeholder.as_ref()?;
                    Some((
                        tab_id.clone(),
                        slot.rect.clone(),
                        slot.role.clone(),
                        slot.slot_id.clone(),
                        slot.zoom_factor,
                        RolePlaceholderSurface {
                            surface_instance_id: placeholder.surface_instance_id.clone(),
                            webview: placeholder.webview.clone(),
                        },
                    ))
                })
                .collect::<Vec<_>>()
        };
        for (tab_id, rect, role, slot_id, projected_zoom, placeholder) in placeholders {
            let slot = EmbeddedRoleSlotEffectRecord {
                owner: owner.clone(),
                rect,
                role,
                web: None,
                slot_id,
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
                zoom_factor: projected_zoom,
                zoom_mode: "fixed".to_owned(),
            };
            if owner
                .as_ref()
                .is_some_and(|owner| tab_id.as_str() == owner.tab_id)
            {
                self.close_role_placeholder_surface(placeholder)?;
                let mut state = self.state()?;
                let runtime_slot = state
                    .native_resources
                    .tabs
                    .get_mut(&tab_id)
                    .and_then(|tab| tab.slots.get_mut(&slot.slot_id))
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_RUNTIME_ROLE_SLOT_STALE",
                            "Role slot closed while its claimed placeholder was retired.",
                        )
                    })?;
                runtime_slot.placeholder = None;
                runtime_slot.owner_generation = owner.as_ref().map(|owner| owner.generation);
                continue;
            }
            let identity = self.role_placeholder_identity(&tab_id, &slot);
            let serialized_identity = serde_json::to_string(&identity).map_err(|error| {
                RuntimeError::new("SYSTEM_ROLE_PLACEHOLDER_INVALID", error.to_string())
            })?;
            {
                let mut state = self.state()?;
                let runtime_slot = state
                    .native_resources.tabs
                    .get_mut(&tab_id)
                    .and_then(|tab| tab.slots.get_mut(&slot.slot_id))
                    .filter(|runtime_slot| {
                        runtime_slot.placeholder.as_ref().is_some_and(|current| {
                            current.surface_instance_id == placeholder.surface_instance_id
                                && current.webview.label() == placeholder.webview.label()
                        })
                    })
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_RUNTIME_ROLE_SLOT_STALE",
                            "Role slot closed while its placeholder was refreshed.",
                        )
                    })?;
                runtime_slot.owner_generation = owner.as_ref().map(|owner| owner.generation);
                state
                    .role_placeholder_identities
                    .insert(placeholder.webview.label().to_owned(), identity);
            }
            placeholder
                .webview
                .eval(format!(
                    "globalThis.__rionRefreshRoleSlotIdentity?.({serialized_identity});"
                ))
                .map_err(RuntimeError::tauri)?;
        }
        Ok(())
    }

    fn schedule_released_role_placeholder_refresh(&self, role_ids: Vec<String>) {
        let Some(runtime) = self.self_weak.get().and_then(Weak::upgrade) else {
            return;
        };
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(feature = "desktop-e2e")]
            let started = Instant::now();
            let mut first_error = None;
            for role_id in &role_ids {
                if let Err(error) = runtime.refresh_role_placeholders(role_id, None) {
                    eprintln!(
                        "Released role placeholder refresh failed: role={role_id} error={}",
                        error.message
                    );
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
            #[cfg(feature = "desktop-e2e")]
            crate::desktop_e2e::record_event(
                "role-placeholder-refresh-terminal",
                None,
                None,
                None,
                json!({
                    "elapsedMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    "errorCode": first_error.as_ref().map(|error| error.code),
                    "roleIds": role_ids,
                    "status": if first_error.is_some() { "failed" } else { "completed" },
                }),
            );
        });
    }
}
