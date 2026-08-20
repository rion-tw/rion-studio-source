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
                        .native_resources.display_hosts
                        .get(lifecycle_id)
                        .map(|_| lifecycle_id.to_owned())
                        .or_else(|| {
                            state.native_resources.display_hosts.iter().find_map(|(window_id, host)| {
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
        tauri::async_runtime::block_on(self.destroy_role_event_bound(role_id))
    }

    async fn destroy_role_event_bound(&self, role_id: &str) -> RuntimeResult<()> {
        {
            let mut state = self.state()?;
            let Some(tab_id) = state.native_tab_id_for_role_surface(role_id) else {
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
        self.surface_recoveries.cancel_active_for_role(role_id);
        self.fence_and_drain_role_input_lane(role_id)?;
        self.discard_role_navigation_input_fences(role_id, "role-closed");
        let result = self.destroy_marked_role_event_bound(role_id, None).await;
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_roles.remove(role_id);
        }
        self.tab_close_changed.notify_all();
        result
    }

    async fn destroy_marked_role_event_bound(
        &self,
        role_id: &str,
        expected_tab_id: Option<&str>,
    ) -> RuntimeResult<()> {
        let released = self
            .release_marked_role_surfaces_event_bound(role_id, expected_tab_id)
            .await?;
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

    async fn release_marked_role_surfaces_event_bound(
        &self,
        role_id: &str,
        expected_tab_id: Option<&str>,
    ) -> RuntimeResult<ReleasedRoleSurface> {
        let (tab_id, webview, lifecycle, surface_instance_id, webview_label, popup_labels) = {
            let state = self.state()?;
            let tab_id = state.native_tab_id_for_role_surface(role_id).cloned().ok_or_else(|| {
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
                .native_resources.tabs
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
            self.close_surface_event_bound(
                &webview,
                &lifecycle,
                role_id,
                SurfaceClosePlan {
                    checkpoint_role_cookies: current_runtime_platform() == "windows",
                    defer_navigation_to_preflight: true,
                    release_boundary: SurfaceReleaseBoundary::DedicatedStore,
                    requires_page_quiesce: true,
                },
            )
                .await?;
            Ok(())
        } else {
            let group_surfaces = {
                let state = self.state()?;
                surface_ids
                    .iter()
                    .filter_map(|instance_id| {
                        state
                            .native_resources.surface_registry
                            .get(instance_id)
                            .or_else(|| state.native_resources.retired_surface_registry.get(instance_id))
                            .cloned()
                    })
                    .collect::<Vec<_>>()
            };
            let runtime = self
                .self_weak
                .get()
                .and_then(Weak::upgrade)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_LIFECYCLE_UNAVAILABLE",
                        "The surface lifecycle actor is unavailable.",
                    )
                })?;
            let mut closes = tokio::task::JoinSet::new();
            for instance_id in surface_ids {
                let runtime = Arc::clone(&runtime);
                let lifecycle_id = role_id.to_owned();
                closes.spawn(async move {
                    runtime
                        .close_managed_surface_event_bound(&instance_id, &lifecycle_id)
                        .await
                });
            }
            let mut first_error = None;
            while let Some(result) = closes.join_next().await {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        if first_error.is_none() {
                            self.cancel_surface_group_continuations(
                                group_surfaces.clone(),
                                "SYSTEM_SURFACE_GROUP_CANCELLED",
                                "A sibling surface failure ended this close-group continuation.",
                            );
                            first_error = Some(error);
                        }
                    }
                    Err(_) => {
                        if first_error.is_none() {
                            self.cancel_surface_group_continuations(
                                group_surfaces.clone(),
                                "SYSTEM_SURFACE_GROUP_CANCELLED",
                                "A sibling surface actor failure ended this close-group continuation.",
                            );
                            first_error = Some(RuntimeError::new(
                                "SYSTEM_SURFACE_CLOSE_ACTOR_FAILED",
                                "A surface lifecycle continuation stopped unexpectedly.",
                            ));
                        }
                    }
                }
            }
            first_error.map_or(Ok(()), Err)
        };
        isolation_result?;
        // Native isolation is the terminal owner event for this input lane. A
        // late about:blank callback must not leave a navigation fence behind
        // after the exact role surface has been released.
        self.discard_role_navigation_input_fences(role_id, "role-native-release");
        self.retire_role_input_surface(role_id)?;
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
            .native_tab_id_for_role_surface(&released.role_id)
            .cloned()
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The closed runtime role no longer has an authoritative mapping.",
                )
            })?;
        let current_surface = state
            .native_resources.tabs
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
        state.audible_webviews.remove(&released.webview_label);
        state.recovery_budgets.remove(&released.role_id);
        state.recovery_generations.remove(&released.role_id);
        state.recovering_roles.remove(&released.role_id);
        state
            .native_resources.tabs
            .get_mut(&released.tab_id)
            .expect("the close transaction validated the runtime tab")
            .roles
            .remove(&released.role_id);
        drop(state);
        self.input_readiness.notify();
        Ok(())
    }

    fn create_available_placeholder(
        &self,
        released: &ReleasedRoleSurface,
    ) -> RuntimeResult<()> {
        let live_window_id = self.resolve_live_tab_window_id(&released.tab_id)?;
        let (window, window_id, role, rect, slot_id, projected_zoom) = {
            let state = self.state()?;
            let tab = state.native_resources.tabs.get(&released.tab_id).ok_or_else(|| {
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
            let host = state.native_resources.display_hosts.get(&live_window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "The runtime display host closed before the placeholder was restored.",
                )
            })?;
            (
                host.window.clone(),
                live_window_id.clone(),
                slot.role.clone(),
                slot.rect.clone(),
                slot.slot_id.clone(),
                slot.zoom_factor,
            )
        };
        let (zoom_factor, adaptive) = self.runtime_role_zoom_contract(
            &window_id,
            &released.tab_id,
            &released.role_id,
            projected_zoom,
        );
        let slot = EmbeddedRoleSlotEffectRecord {
            owner: None,
            rect,
            role,
            web: None,
            slot_id,
            state: "available".to_owned(),
            zoom_factor,
            zoom_mode: if adaptive { "adaptive" } else { "fixed" }.to_owned(),
        };
        let metrics = runtime_window_content_metrics(&window)?;
        let bounds = role_bounds_for_content(metrics, &slot.rect);
        let placeholder = self.create_role_placeholder(
            &window,
            &window_id,
            &released.tab_id,
            &slot,
            bounds,
        )?;
        let inserted = {
            let mut state = self.state()?;
            state
                .native_resources.tabs
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
        tauri::async_runtime::block_on(self.destroy_tab_event_bound(tab_id))
    }

    async fn destroy_tab_event_bound(&self, tab_id: &str) -> RuntimeResult<()> {
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
            let Some(tab) = state.native_resources.tabs.get(tab_id) else {
                return Ok(());
            };
            (tab.roles.keys().cloned().collect::<Vec<_>>(), window_id)
        };
        let tab_group_surfaces = {
            let state = self.state()?;
            state
                .native_resources.surface_registry
                .values()
                .chain(state.native_resources.retired_surface_registry.values())
                .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                .cloned()
                .collect::<Vec<_>>()
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
            self.surface_recoveries.cancel_active_for_role(role_id);
            self.fence_and_drain_role_input_lane(role_id)?;
            self.discard_role_navigation_input_fences(role_id, "workspace-closed");
        }
        let mut completed_tombstone = None;
        let result: RuntimeResult<()> = async {
            let runtime = self
                .self_weak
                .get()
                .and_then(Weak::upgrade)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_LIFECYCLE_UNAVAILABLE",
                        "The surface lifecycle actor is unavailable.",
                    )
                })?;
            let mut closes = tokio::task::JoinSet::new();
            for role_id in &role_ids {
                let runtime = Arc::clone(&runtime);
                let role_id = role_id.clone();
                let expected_tab_id = tab_id.to_owned();
                closes.spawn(async move {
                    runtime
                        .release_marked_role_surfaces_event_bound(
                            &role_id,
                            Some(&expected_tab_id),
                        )
                        .await
                });
            }
            let mut released_roles = Vec::with_capacity(role_ids.len());
            let mut first_error = None;
            while let Some(result) = closes.join_next().await {
                match result {
                    Ok(Ok(released)) => released_roles.push(released),
                    Ok(Err(error)) => {
                        if first_error.is_none() {
                            self.cancel_surface_group_continuations(
                                tab_group_surfaces.clone(),
                                "SYSTEM_SURFACE_GROUP_CANCELLED",
                                "A workspace sibling failure ended the pending close-group continuations.",
                            );
                            first_error = Some(error);
                        }
                    }
                    Err(_) => {
                        if first_error.is_none() {
                            self.cancel_surface_group_continuations(
                                tab_group_surfaces.clone(),
                                "SYSTEM_SURFACE_GROUP_CANCELLED",
                                "A workspace sibling actor failure ended the pending close-group continuations.",
                            );
                            first_error = Some(RuntimeError::new(
                                "SYSTEM_SURFACE_CLOSE_ACTOR_FAILED",
                                "A workspace surface lifecycle continuation stopped unexpectedly.",
                            ));
                        }
                    }
                }
            }
            if let Some(error) = first_error {
                return Err(error);
            }
            let released_dividers = {
                let state = self.state()?;
                state
                    .native_resources.tabs
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
                self.close_managed_surface_event_bound(instance_id, instance_id)
                    .await?;
            }
            let released_placeholders = {
                let state = self.state()?;
                state
                    .native_resources.tabs
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
            if state.native_resources.surface_registry.values().any(|surface| {
                surface.tab_id.as_deref() == Some(tab_id)
                    && surface.kind != ManagedSurfaceKind::Divider
                    && surface.phase.blocks_role_relaunch()
            }) {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "Rion Studio could not verify that every native game page stopped. The tab remains closed; restart Rion Studio before reopening these roles.",
                ));
            }
            let current_tab = state.native_resources.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The runtime tab disappeared before its close transaction committed.",
                )
            })?;
            let roles_current = current_tab.roles.len() == released_roles.len()
                && released_roles.iter().all(|released| {
                    state.native_tab_id_for_role_surface(&released.role_id) == Some(&released.tab_id)
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
                state.audible_webviews.remove(&released.webview_label);
                state.recovery_budgets.remove(&released.role_id);
                state.recovery_generations.remove(&released.role_id);
                state.recovering_roles.remove(&released.role_id);
            }
            state.native_resources.tabs.remove(tab_id);
            self.presentation.statuses.remove(tab_id);
            self.notify_optional_idle_changed();
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
            drop(state);
            Ok(())
        }
        .await;
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_tabs.remove(tab_id);
            role_ids.iter().for_each(|role_id| {
                state.close_coordinator.closing_roles.remove(role_id);
            });
        }
        self.tab_close_changed.notify_all();
        self.input_readiness.notify();
        let authority_result = completed_tombstone
            .as_ref()
            .map(|tombstone| {
                self.apply_runtime_native_event_for_operation(
                    &tombstone.kernel_operation_id,
                    "closed",
                )
                .map(|_| ())
            })
            .transpose();
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
        let terminal_result = result.and(authority_result.map(|_| ()));
        #[cfg(feature = "desktop-e2e")]
        {
            let (status, error_code, error_message) = match &terminal_result {
                Ok(()) => ("completed", None, None),
                Err(error) => (
                    "failed",
                    Some(error.code),
                    Some(error.message.as_str()),
                ),
            };
            crate::desktop_e2e::record_event(
                "runtime-tab-close-terminal",
                Some(&window_id),
                None,
                completed_tombstone
                    .as_ref()
                    .map(|tombstone| tombstone.revision),
                json!({
                    "error": error_message,
                    "errorCode": error_code,
                    "roleIds": role_ids,
                    "status": status,
                    "tabId": tab_id,
                }),
            );
        }
        if terminal_result.is_ok() {
            self.schedule_released_role_placeholder_refresh(role_ids.clone());
        }
        terminal_result
    }

}
