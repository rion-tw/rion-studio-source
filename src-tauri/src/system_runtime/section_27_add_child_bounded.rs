fn surface_host_initialization_should_restore_hidden(
    initialized_for_operation: bool,
    desired_host_visibility: Option<bool>,
    applied_host_visibility: Option<bool>,
) -> bool {
    initialized_for_operation
        && applied_host_visibility.or(desired_host_visibility) == Some(false)
}

fn snapshot_initialized_surface_host<T>(
    initialized_for_operation: bool,
    snapshot: impl FnOnce() -> T,
) -> Option<T> {
    initialized_for_operation.then(snapshot)
}

impl SystemRuntimeExecutor {
    fn add_child_bounded(
        &self,
        window: &Window,
        builder: WebviewBuilder<tauri::Wry>,
        position: LogicalPosition<f64>,
        size: LogicalSize<f64>,
        lifecycle_id: &str,
    ) -> RuntimeResult<Webview> {
        let restore_parent = self.prepare_surface_parent_for_creation(window, lifecycle_id)?;
        let stage = format!("native-webview-create:{lifecycle_id}");
        let started = Instant::now();
        self.record_runtime_stage(&stage, "started", started);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let create_window = window.clone();
        std::thread::Builder::new()
            .name("rion-webview-create".to_owned())
            .spawn(move || {
                let result = create_window.add_child(builder, position, size);
                if let Err(mpsc::SendError(Ok(stale_webview))) = sender.send(result) {
                    // The bounded caller timed out. A late native callback must never
                    // become the active surface for a newer lifecycle generation.
                    let _ = stale_webview.close();
                }
            })
            .map_err(|error| {
                RuntimeError::new("SYSTEM_WEBVIEW_CREATE_WORKER_FAILED", error.to_string())
            })?;
        match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
            Ok(result) => {
                let release = self.finish_surface_host_initialization(
                    window,
                    restore_parent,
                    Some(false),
                    lifecycle_id,
                );
                let outcome = match (result.map_err(RuntimeError::tauri), release) {
                    (Ok(webview), Ok(())) => Ok(webview),
                    (Ok(webview), Err(error)) => {
                        let _ = webview.close();
                        Err(error)
                    }
                    (Err(error), Ok(())) => Err(error),
                    (Err(_), Err(error)) => Err(error),
                };
                match outcome.as_ref() {
                    Ok(_) => self.record_runtime_stage(stage, "completed", started),
                    Err(error) => self.record_runtime_stage_failure(stage, started, error),
                }
                outcome
            }
            Err(error) => {
                self.record_runtime_stage(stage, "failed", started);
                let failure_kind = match error {
                    mpsc::RecvTimeoutError::Timeout => "creation-timeout",
                    mpsc::RecvTimeoutError::Disconnected => "creation-worker-disconnected",
                };
                let message = format!(
                    "The System WebView surface {lifecycle_id} did not finish native creation within {}ms. Its late result will be closed before another attempt uses it.",
                    PLATFORM_CALLBACK_TIMEOUT.as_millis()
                );
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "SYSTEM_WEBVIEW_CREATION_STALLED",
                        "failureKind": failure_kind,
                        "message": message,
                        "surfaceId": lifecycle_id,
                        "windowId": window.label()
                    }),
                );
                let cleanup = match receiver.recv_timeout(SURFACE_RECLAMATION_TIMEOUT) {
                    Ok(Ok(stale_webview)) => self
                        .close_untracked_failed_launch_surface_and_wait(
                            &stale_webview,
                            lifecycle_id,
                        ),
                    Ok(Err(_)) => Ok(()),
                    Err(_) => Err(RuntimeError::new(
                        "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                        "The timed-out native WebView creation did not settle before the cleanup deadline. Restart Rion Studio before retrying.",
                    )),
                };
                let restore = self.finish_surface_host_initialization(
                    window,
                    restore_parent,
                    Some(false),
                    lifecycle_id,
                );
                if let Err(cleanup_error) = cleanup {
                    self.health.mark_unhealthy();
                    return Err(cleanup_error);
                }
                restore?;
                Err(RuntimeError::new(
                    "SYSTEM_WEBVIEW_CREATION_STALLED",
                    message,
                ))
            }
        }
    }

    fn prepare_surface_parent_for_creation(
        &self,
        window: &Window,
        lifecycle_id: &str,
    ) -> RuntimeResult<bool> {
        #[cfg(windows)]
        {
            if window.is_visible().map_err(RuntimeError::tauri)? {
                return Ok(false);
            }
            self.begin_surface_host_initialization(window, lifecycle_id)?;
            Ok(true)
        }
        #[cfg(target_os = "macos")]
        {
            self.begin_surface_host_initialization(window, lifecycle_id)?;
            Ok(true)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (window, lifecycle_id);
            Ok(false)
        }
    }

    fn create_window_bounded(
        &self,
        lifecycle_id: &str,
        create: impl FnOnce() -> tauri::Result<Window> + Send + 'static,
    ) -> RuntimeResult<Window> {
        let stage = format!("native-window-create:{lifecycle_id}");
        let started = Instant::now();
        self.record_runtime_stage(&stage, "started", started);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("rion-window-create".to_owned())
            .spawn(move || {
                let result = create();
                if let Err(mpsc::SendError(Ok(stale_window))) = sender.send(result) {
                    let _ = stale_window.close();
                }
            })
            .map_err(|error| {
                RuntimeError::new("SYSTEM_WINDOW_CREATE_WORKER_FAILED", error.to_string())
            })?;
        match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
            Ok(Ok(window)) => {
                self.record_runtime_stage(stage, "completed", started);
                Ok(window)
            }
            Ok(Err(error)) => {
                self.record_runtime_stage(stage, "failed", started);
                Err(RuntimeError::tauri(error))
            }
            Err(error) => {
                self.record_runtime_stage(stage, "failed", started);
                let failure_kind = match error {
                    mpsc::RecvTimeoutError::Timeout => "window-creation-timeout",
                    mpsc::RecvTimeoutError::Disconnected => "window-creation-worker-disconnected",
                };
                let message = format!(
                    "The native host window {lifecycle_id} did not finish creation within {}ms. Its late result will be closed before another attempt uses it.",
                    PLATFORM_CALLBACK_TIMEOUT.as_millis()
                );
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "SYSTEM_WEBVIEW_CREATION_STALLED",
                        "failureKind": failure_kind,
                        "message": message,
                        "windowId": lifecycle_id
                    }),
                );
                let cleanup = match receiver.recv_timeout(SURFACE_RECLAMATION_TIMEOUT) {
                    Ok(Ok(stale_window)) => self.close_untracked_failed_launch_window_and_wait(
                        &stale_window,
                        lifecycle_id,
                    ),
                    Ok(Err(_)) => Ok(()),
                    Err(_) => Err(RuntimeError::new(
                        "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                        "The timed-out native host window creation did not settle before the cleanup deadline. Restart Rion Studio before retrying.",
                    )),
                };
                if let Err(cleanup_error) = cleanup {
                    self.health.mark_unhealthy();
                    return Err(cleanup_error);
                }
                Err(RuntimeError::new(
                    "SYSTEM_WEBVIEW_CREATION_STALLED",
                    message,
                ))
            }
        }
    }

    fn begin_surface_host_initialization(
        &self,
        window: &Window,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        let requires_visible_parent =
            surface_host_initialization_requires_visible_parent(if cfg!(windows) {
                "windows"
            } else {
                "macos"
            });
        #[cfg(windows)]
        {
            debug_assert!(requires_visible_parent);
            let stage = format!("surface-host-visible:{lifecycle_id}");
            let started = Instant::now();
            self.record_runtime_stage(&stage, "started", started);
            if let Err(error) = set_windows_surface_host_initialization_visibility(window, true) {
                self.record_runtime_stage(stage, "failed", started);
                return Err(error);
            }
            self.record_runtime_stage(stage, "completed", started);
        }
        #[cfg(target_os = "macos")]
        {
            let _ = (window, lifecycle_id);
            debug_assert!(!requires_visible_parent);
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (requires_visible_parent, window, lifecycle_id);
        }
        Ok(())
    }

    fn finish_surface_host_initialization(
        &self,
        window: &Window,
        initialized_for_operation: bool,
        desired_host_visibility: Option<bool>,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        let Some(logical_window_id) = snapshot_initialized_surface_host(
            initialized_for_operation,
            || {
                self.state.lock().ok().and_then(|state| {
                    state
                        .display_hosts
                        .get(lifecycle_id)
                        .map(|_| lifecycle_id.to_owned())
                        .or_else(|| {
                            state.display_hosts.iter().find_map(|(window_id, host)| {
                                (host.window.label() == window.label()).then(|| window_id.clone())
                            })
                        })
                })
            },
        ) else {
            return Ok(());
        };
        let applied_host_visibility = logical_window_id
            .as_deref()
            .and_then(|window_id| self.presentation.applied_window_visibility(window_id));
        if !surface_host_initialization_should_restore_hidden(
            initialized_for_operation,
            desired_host_visibility,
            applied_host_visibility,
        ) {
            return Ok(());
        }
        #[cfg(windows)]
        {
            let stage = format!("surface-host-hidden:{lifecycle_id}");
            let started = Instant::now();
            self.record_runtime_stage(&stage, "started", started);
            if let Err(error) = set_windows_surface_host_initialization_visibility(window, false) {
                self.record_runtime_stage(stage, "failed", started);
                return Err(error);
            }
            self.record_runtime_stage(stage, "completed", started);
        }
        #[cfg(target_os = "macos")]
        {
            let _ = (window, lifecycle_id);
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = (window, lifecycle_id);
        Ok(())
    }

    fn destroy_role(&self, role_id: &str) -> RuntimeResult<()> {
        {
            let mut state = self.state()?;
            let Some(tab_id) = state.role_tabs.get(role_id) else {
                if state.close_coordinator.quarantined_roles.contains(role_id) {
                    return Err(RuntimeError::new(
                        "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                        "The native role surface remains quarantined after a failed close.",
                    ));
                }
                return Ok(());
            };
            if state.close_coordinator.closing_tabs.contains(tab_id)
                || !state
                    .close_coordinator
                    .closing_roles
                    .insert(role_id.to_owned())
            {
                return Ok(());
            }
        }
        self.advance_role_input_fence_local(role_id)?;
        self.discard_role_navigation_input_fences(role_id, "role-closed");
        let result = self.destroy_marked_role(role_id, None);
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_roles.remove(role_id);
        }
        result
    }

    fn destroy_marked_role(
        &self,
        role_id: &str,
        expected_tab_id: Option<&str>,
    ) -> RuntimeResult<()> {
        let released = self.release_marked_role_surfaces(role_id, expected_tab_id)?;
        self.commit_released_role(&released)?;
        if self
            .presentation
            .tab_window(&released.tab_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?
            .is_none()
        {
            // The visible source tab is already gone, so there is no source slot
            // where a placeholder may be created. The owner release still has to
            // reach placeholders in newer tabs that asked for the same role while
            // native isolation was finishing.
            return self.refresh_role_placeholders(role_id, None);
        }
        self.create_available_placeholder(&released)?;
        self.refresh_role_placeholders(role_id, None)
    }

    fn release_marked_role_surfaces(
        &self,
        role_id: &str,
        expected_tab_id: Option<&str>,
    ) -> RuntimeResult<ReleasedRoleSurface> {
        let (tab_id, webview, lifecycle, surface_instance_id, webview_label, popup_labels) = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            if expected_tab_id.is_some_and(|expected| expected != tab_id) {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The runtime role moved before its close transaction completed.",
                ));
            }
            let surface = state
                .tabs
                .get(&tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role was not found.",
                    )
                })?;
            let popup_labels = state
                .popup_roles
                .iter()
                .filter(|(_, popup_role_id)| popup_role_id.as_str() == role_id)
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            (
                tab_id,
                surface.webview.clone(),
                Arc::clone(&surface.lifecycle),
                surface.surface_instance_id.clone(),
                surface.webview.label().to_owned(),
                popup_labels,
            )
        };

        self.clear_role_keys(role_id);
        let surface_ids = self.managed_surface_ids_for_role(role_id)?;
        let isolation_result = if surface_ids.is_empty() {
            self.close_surface_and_wait(&webview, &lifecycle, role_id)?;
            Ok(())
        } else {
            // A role page, recovery replacement and its popups are independent
            // controllers. Request isolation concurrently so a wedged popup cannot
            // delay the exact game surface or multiply the two-second bound.
            std::thread::scope(|scope| {
                let handles = surface_ids
                    .iter()
                    .map(|instance_id| {
                        scope.spawn(move || {
                            self.close_managed_surface_and_wait(instance_id, role_id)
                        })
                    })
                    .collect::<Vec<_>>();
                let mut first_error = None;
                for handle in handles {
                    match handle.join() {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => {
                            first_error.get_or_insert(error);
                        }
                        Err(_) => {
                            first_error.get_or_insert_with(|| {
                                RuntimeError::new(
                                    "SYSTEM_SURFACE_CLOSE_WORKER_FAILED",
                                    "A native role surface close worker panicked.",
                                )
                            });
                        }
                    }
                }
                first_error.map_or(Ok(()), Err)
            })
        };
        isolation_result?;
        for label in popup_labels {
            self.forget_popup(&label);
        }
        if !self.managed_surface_ids_for_role(role_id)?.is_empty() {
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.",
            ));
        }

        Ok(ReleasedRoleSurface {
            role_id: role_id.to_owned(),
            surface_instance_id,
            tab_id,
            webview_label,
        })
    }

    fn commit_released_role(&self, released: &ReleasedRoleSurface) -> RuntimeResult<()> {
        let mut state = self.state()?;
        let current_tab_id = state
            .role_tabs
            .get(&released.role_id)
            .cloned()
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The closed runtime role no longer has an authoritative mapping.",
                )
            })?;
        let current_surface = state
            .tabs
            .get(&released.tab_id)
            .and_then(|tab| tab.roles.get(&released.role_id))
            .map(|surface| {
                (
                    surface.webview.label(),
                    surface.surface_instance_id.as_str(),
                )
            });
        if current_surface.is_none_or(|(current_label, current_instance_id)| {
            !surface_close_commit_is_current(
                &current_tab_id,
                &released.tab_id,
                current_label,
                &released.webview_label,
            ) || current_instance_id != released.surface_instance_id
        }) {
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_CLOSE_STALE",
                "A newer runtime role surface superseded the closed handle.",
            ));
        }
        state.role_tabs.remove(&released.role_id);
        state.audible_webviews.remove(&released.webview_label);
        state.recovery_budgets.remove(&released.role_id);
        state.recovery_generations.remove(&released.role_id);
        state.recovering_roles.remove(&released.role_id);
        state
            .tabs
            .get_mut(&released.tab_id)
            .expect("the close transaction validated the runtime tab")
            .roles
            .remove(&released.role_id);
        Ok(())
    }

    fn create_available_placeholder(
        &self,
        released: &ReleasedRoleSurface,
    ) -> RuntimeResult<()> {
        let live_window_id = self.resolve_live_tab_window_id(&released.tab_id)?;
        let (window, window_id, slot, selected) = {
            let state = self.state()?;
            let tab = state.tabs.get(&released.tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The role tab disappeared before its placeholder could be restored.",
                )
            })?;
            let slot = tab
                .slots
                .values()
                .find(|slot| slot.role.id == released.role_id)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_ROLE_SLOT_NOT_FOUND",
                        "The stopped role no longer has a runtime slot.",
                    )
                })?;
            let host = state.display_hosts.get(&live_window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "The runtime display host closed before the placeholder was restored.",
                )
            })?;
            let selected = self
                .presentation
                .existing(&live_window_id)
                .and_then(|presentation| {
                    presentation.lock().ok().map(|presentation| {
                        presentation.selected_tab_id.as_deref() == Some(released.tab_id.as_str())
                    })
                })
                .unwrap_or(false);
            (
                host.window.clone(),
                live_window_id.clone(),
                EmbeddedRoleSlotEffectRecord {
                    owner: None,
                    rect: slot.rect.clone(),
                    role: slot.role.clone(),
                    slot_id: slot.slot_id.clone(),
                    state: "available".to_owned(),
                    zoom_factor: slot.zoom_factor,
                    zoom_mode: slot.zoom_mode.clone(),
                },
                selected,
            )
        };
        let metrics = runtime_window_content_metrics(&window)?;
        let bounds = role_bounds_for_content(metrics, &slot.rect);
        let placeholder = self.create_role_placeholder(
            &window,
            &window_id,
            &released.tab_id,
            &slot,
            bounds,
            selected,
        )?;
        let inserted = {
            let mut state = self.state()?;
            state
                .tabs
                .get_mut(&released.tab_id)
                .and_then(|tab| tab.slots.get_mut(&slot.slot_id))
                .filter(|runtime_slot| runtime_slot.placeholder.is_none())
                .map(|runtime_slot| {
                    runtime_slot.owner_generation = None;
                    runtime_slot.placeholder = Some(RolePlaceholderSurface {
                        surface_instance_id: placeholder.surface_instance_id.clone(),
                        webview: placeholder.webview.clone(),
                    });
                })
                .is_some()
        };
        if !inserted {
            self.close_role_placeholder_surface(placeholder)?;
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_CLOSE_STALE",
                "The runtime role slot changed before its placeholder could commit.",
            ));
        }
        self.layout_runtime_tab_inner(&released.tab_id)
    }

    fn destroy_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let window_id = self
            .presentation
            .tab_window(tab_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?
            .or_else(|| {
                self.state
                    .lock()
                    .ok()
                    .and_then(|state| state.close_previews.get(tab_id).map(|item| item.window_id.clone()))
            })
            .or_else(|| self.native_tab_host_id(tab_id));
        let Some(window_id) = window_id else {
            return Ok(());
        };
        let (role_ids, window_id) = {
            let state = self.state()?;
            let Some(tab) = state.tabs.get(tab_id) else {
                return Ok(());
            };
            (tab.roles.keys().cloned().collect::<Vec<_>>(), window_id)
        };
        {
            let mut state = self.state()?;
            if state.close_coordinator.closing_tabs.contains(tab_id)
                || role_ids
                    .iter()
                    .any(|role_id| state.close_coordinator.closing_roles.contains(role_id))
            {
                return Ok(());
            }
            state
                .close_coordinator
                .closing_tabs
                .insert(tab_id.to_owned());
            state
                .close_coordinator
                .closing_roles
                .extend(role_ids.iter().cloned());
        }
        for role_id in &role_ids {
            self.advance_role_input_fence_local(role_id)?;
            self.discard_role_navigation_input_fences(role_id, "workspace-closed");
        }
        let mut completed_tombstone = None;
        let result = (|| -> RuntimeResult<()> {
            // A workspace's game surfaces are independent native controllers. Isolate
            // them concurrently so one wedged role cannot serialize every sibling.
            let released_roles = std::thread::scope(|scope| {
                let handles = role_ids
                    .iter()
                    .map(|role_id| {
                        scope
                            .spawn(move || self.release_marked_role_surfaces(role_id, Some(tab_id)))
                    })
                    .collect::<Vec<_>>();
                handles
                    .into_iter()
                    .map(|handle| {
                        handle.join().unwrap_or_else(|_| {
                            Err(RuntimeError::new(
                                "SYSTEM_SURFACE_CLOSE_WORKER_FAILED",
                                "A native workspace surface close worker panicked.",
                            ))
                        })
                    })
                    .collect::<RuntimeResult<Vec<_>>>()
            })?;
            let released_dividers = {
                let state = self.state()?;
                state
                    .tabs
                    .get(tab_id)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_SURFACE_CLOSE_STALE",
                            "The runtime tab disappeared during divider cleanup.",
                        )
                    })?
                    .dividers
                    .iter()
                    .map(|divider| {
                        (
                            divider.index,
                            divider.surface_instance_id.clone(),
                            divider.webview.label().to_owned(),
                        )
                    })
                    .collect::<Vec<_>>()
            };
            for (_, instance_id, _) in &released_dividers {
                self.close_managed_divider(instance_id)?;
            }
            let released_placeholders = {
                let state = self.state()?;
                state
                    .tabs
                    .get(tab_id)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_SURFACE_CLOSE_STALE",
                            "The runtime tab disappeared during placeholder cleanup.",
                        )
                    })?
                    .slots
                    .values()
                    .filter_map(|slot| {
                        slot.placeholder.as_ref().map(|placeholder| RolePlaceholderSurface {
                            surface_instance_id: placeholder.surface_instance_id.clone(),
                            webview: placeholder.webview.clone(),
                        })
                    })
                    .collect::<Vec<_>>()
            };
            for placeholder in released_placeholders {
                self.close_role_placeholder_surface(placeholder)?;
            }

            let mut state = self.state()?;
            if state.surface_registry.values().any(|surface| {
                surface.tab_id.as_deref() == Some(tab_id)
                    && surface.kind != ManagedSurfaceKind::Divider
                    && surface.phase.blocks_role_relaunch()
            }) {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "Rion Studio could not verify that every native game page stopped. The tab remains closed; restart Rion Studio before reopening these roles.",
                ));
            }
            let current_tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The runtime tab disappeared before its close transaction committed.",
                )
            })?;
            let roles_current = current_tab.roles.len() == released_roles.len()
                && released_roles.iter().all(|released| {
                    state.role_tabs.get(&released.role_id) == Some(&released.tab_id)
                        && current_tab
                            .roles
                            .get(&released.role_id)
                            .is_some_and(|surface| {
                                surface.surface_instance_id == released.surface_instance_id
                                    && surface.webview.label() == released.webview_label
                            })
                });
            let dividers_current = current_tab.dividers.len() == released_dividers.len()
                && released_dividers.iter().all(|(index, instance_id, label)| {
                    current_tab.dividers.iter().any(|divider| {
                        divider.index == *index
                            && divider.surface_instance_id == *instance_id
                            && divider.webview.label() == label
                    })
                });
            if !roles_current || !dividers_current {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The runtime tab changed before its close transaction committed.",
                ));
            }
            for released in &released_roles {
                state.role_tabs.remove(&released.role_id);
                state.audible_webviews.remove(&released.webview_label);
                state.recovery_budgets.remove(&released.role_id);
                state.recovery_generations.remove(&released.role_id);
                state.recovering_roles.remove(&released.role_id);
            }
            state.tabs.remove(tab_id);
            state.native_tab_hosts.remove(tab_id);
            self.presentation.statuses.remove(tab_id);
            // A successful native destroy is the authoritative close boundary,
            // including when it came from BrowserWindowStop rather than the
            // per-tab command. Retire the live tombstone in the same state commit
            // so reopening a saved tab with its stable ID cannot observe a stale
            // `closing` fence between locks.
            completed_tombstone = retire_completed_tab_close_fence(&mut state, tab_id);
            state.close_coordinator.closing_tabs.remove(tab_id);
            role_ids.iter().for_each(|role_id| {
                state.close_coordinator.closing_roles.remove(role_id);
            });
            Ok(())
        })();
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_tabs.remove(tab_id);
            role_ids.iter().for_each(|role_id| {
                state.close_coordinator.closing_roles.remove(role_id);
            });
        }
        self.tab_close_changed.notify_all();
        if result.is_ok() {
            if let Some(tombstone) = completed_tombstone.as_ref() {
                self.record_tab_close_tombstone_resolution(tab_id, tombstone, true);
            }
            self.publish_launcher_presence();
            self.complete_retiring_window_tab(
                &window_id,
                tab_id,
                false,
                completed_tombstone
                    .as_ref()
                    .and_then(|tombstone| tombstone.retirement_revision),
            );
        } else {
            self.retire_quarantined_tab_after_close(tab_id);
            self.complete_retiring_window_tab(
                &window_id,
                tab_id,
                true,
                self.state.lock().ok().and_then(|state| {
                    state
                        .close_previews
                        .get(tab_id)
                        .and_then(|tombstone| tombstone.retirement_revision)
                }),
            );
        }
        result
    }

}
