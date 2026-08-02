fn surface_host_initialization_should_restore_hidden(
    initialized_for_operation: bool,
    desired_host_visibility: Option<bool>,
) -> bool {
    initialized_for_operation && desired_host_visibility == Some(false)
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
        self.health.require_healthy()?;
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
                self.record_runtime_stage(
                    stage,
                    if result.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    },
                    started,
                );
                let release =
                    self.finish_surface_host_initialization(window, restore_parent, lifecycle_id);
                match (result, release) {
                    (Ok(webview), Ok(())) => Ok(webview),
                    (Ok(webview), Err(error)) => {
                        let _ = webview.close();
                        Err(error)
                    }
                    (Err(error), Ok(())) => Err(RuntimeError::tauri(error)),
                    (Err(_), Err(error)) => Err(error),
                }
            }
            Err(error) => {
                self.record_runtime_stage(stage, "failed", started);
                self.health.mark_unhealthy();
                let failure_kind = match error {
                    mpsc::RecvTimeoutError::Timeout => "creation-timeout",
                    mpsc::RecvTimeoutError::Disconnected => "creation-worker-disconnected",
                };
                let message = format!(
                    "The System WebView surface {lifecycle_id} did not finish native creation within {}ms. Restart Rion Studio before launching another browser role.",
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
        self.health.require_healthy()?;
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
                self.health.mark_unhealthy();
                let failure_kind = match error {
                    mpsc::RecvTimeoutError::Timeout => "window-creation-timeout",
                    mpsc::RecvTimeoutError::Disconnected => "window-creation-worker-disconnected",
                };
                let message = format!(
                    "The native host window {lifecycle_id} did not finish creation within {}ms. Restart Rion Studio before launching another browser role.",
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
                self.health.mark_unhealthy();
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
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        if !initialized_for_operation {
            return Ok(());
        }
        #[cfg(windows)]
        {
            let stage = format!("surface-host-hidden:{lifecycle_id}");
            let started = Instant::now();
            self.record_runtime_stage(&stage, "started", started);
            if let Err(error) = set_windows_surface_host_initialization_visibility(window, false) {
                self.record_runtime_stage(stage, "failed", started);
                self.health.mark_unhealthy();
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
            let tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            if state.close_coordinator.closing_tabs.contains(tab_id)
                || !state
                    .close_coordinator
                    .closing_roles
                    .insert(role_id.to_owned())
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_ALREADY_CLOSING",
                    "The runtime role is already closing.",
                ));
            }
        }
        self.advance_role_input_fence_local(role_id)?;
        self.discard_role_navigation_input_fences(role_id);
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
        self.commit_released_role(released)
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

    fn commit_released_role(&self, released: ReleasedRoleSurface) -> RuntimeResult<()> {
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

    fn destroy_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let (role_ids, window_id) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            (
                tab.roles.keys().cloned().collect::<Vec<_>>(),
                tab.window_id.clone(),
            )
        };
        {
            let mut state = self.state()?;
            if state.close_coordinator.closing_tabs.contains(tab_id)
                || role_ids
                    .iter()
                    .any(|role_id| state.close_coordinator.closing_roles.contains(role_id))
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_ALREADY_CLOSING",
                    "The runtime tab or one of its roles is already closing.",
                ));
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
            self.discard_role_navigation_input_fences(role_id);
        }
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
            state.launch_phases.remove(tab_id);
            Ok(())
        })();
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_tabs.remove(tab_id);
            role_ids.iter().for_each(|role_id| {
                state.close_coordinator.closing_roles.remove(role_id);
            });
        }
        if result.is_ok() {
            self.publish_launcher_presence();
            self.remove_empty_display_host(&window_id, true);
        }
        result
    }

}
