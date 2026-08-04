impl SystemRuntimeExecutor {
    fn start_role_loads(
        &self,
        roles: Vec<EmbeddedRoleLoadEffectRecord>,
    ) -> RuntimeResult<Vec<PendingRoleNavigation>> {
        self.require_runtime_accepting()?;
        let lifecycle_epoch = self.lifecycle_epoch();
        let mut pending_navigations = Vec::with_capacity(roles.len());
        let mut controlled_labels = Vec::with_capacity(roles.len());

        let result = (|| -> RuntimeResult<Vec<PendingRoleNavigation>> {
            for role in roles {
                self.require_application_lifecycle_epoch(lifecycle_epoch)?;
                if !is_current_system_engine(role.resolved_engine) {
                    return Err(RuntimeError::new(
                        "SYSTEM_RUNTIME_ENGINE_MISMATCH",
                        "The role did not resolve to the current platform System WebView.",
                    ));
                }
                let close_fenced = {
                    let state = self.state()?;
                    state
                        .close_coordinator
                        .closing_roles
                        .contains(&role.role_id)
                        || state
                            .close_coordinator
                            .quarantined_roles
                            .contains(&role.role_id)
                };
                if close_fenced {
                    return Err(RuntimeError::new(
                        "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                        "The role is closing or quarantined and cannot navigate to the game.",
                    ));
                }
                let (
                    surface,
                    navigation,
                    current_url,
                    base_zoom_factor,
                    effective_zoom,
                    surface_generation,
                    tab_id,
                    window_id,
                ) = {
                    let state = self.state()?;
                    let tab_id = state.role_tabs.get(&role.role_id).ok_or_else(|| {
                        RuntimeError::new(
                            "TAURI_RUNTIME_ROLE_NOT_FOUND",
                            "Runtime role was not found.",
                        )
                    })?;
                    let surface = state.tabs[tab_id].roles.get(&role.role_id).ok_or_else(|| {
                        RuntimeError::new(
                            "TAURI_RUNTIME_ROLE_NOT_FOUND",
                            "Runtime role was not found.",
                        )
                    })?;
                    let base_zoom_factor = if surface.zoom_mode == "adaptive" {
                        surface.zoom_factor
                    } else {
                        role.zoom_factor.clamp(0.25, 3.0)
                    };
                    let window_zoom_factor = state
                        .display_hosts
                        .get(&state.tabs[tab_id].window_id)
                        .map(|host| host.zoom_factor)
                        .unwrap_or(1.0);
                    (
                        surface.webview.clone(),
                        Arc::clone(&surface.navigation),
                        surface.current_url.clone(),
                        base_zoom_factor,
                        effective_zoom_factor(base_zoom_factor, window_zoom_factor),
                        surface.generation,
                        tab_id.clone(),
                        state.tabs[tab_id].window_id.clone(),
                    )
                };
                let url = checked_web_url(&role.url)?;
                let controlled_label = surface.label().to_owned();
                self.begin_controlled_navigation(&controlled_label)?;
                controlled_labels.push(controlled_label);
                let operation = NativeOperationContext::new(
                    NativeOperationSubsystem::Navigation,
                    "embeddedLoadRoles",
                    NAVIGATION_TIMEOUT,
                )
                .with_role(&role.role_id)
                .with_tab(&tab_id)
                .with_window(&window_id)
                .with_lifecycle_epoch(lifecycle_epoch)
                .with_surface_generation(surface_generation);
                self.operations.register(operation.clone()).map_err(|code| {
                    RuntimeError::new(
                        code,
                        "The native operation registry could not accept role navigation.",
                    )
                })?;
                let pending_operation = if current_url.as_ref() != Some(&url) {
                    if let Ok(mut state) = self.state()
                        && let Some(tab_id) = state.role_tabs.get(&role.role_id).cloned()
                        && let Some(role_surface) = state
                            .tabs
                            .get_mut(&tab_id)
                            .and_then(|tab| tab.roles.get_mut(&role.role_id))
                    {
                        // Persist the intended URL before entering the native navigation
                        // call. A renderer process can terminate before page-load events
                        // arrive, and a dead WKWebView may report a nil URL.
                        role_surface.current_url = Some(url.clone());
                        role_surface.zoom_factor = base_zoom_factor;
                    }
                    if let Err(message) = navigation.begin_operation(&operation) {
                        self.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation,
                                "navigationTracker",
                                NativeOperationStatus::Failed,
                                Some("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE"),
                            ),
                        );
                        return Err(RuntimeError::new(
                            "SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE",
                            message,
                        ));
                    }
                    if self
                        .require_application_lifecycle_epoch(lifecycle_epoch)
                        .is_err()
                        || !self.operations.mark_in_flight(&operation.operation_id)
                    {
                        navigation.reset();
                        self.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation,
                                "applicationLifecycleCancelled",
                                NativeOperationStatus::Cancelled,
                                Some("SYSTEM_LIFECYCLE_SUSPENDED"),
                            ),
                        );
                        return Err(RuntimeError::new(
                            "SYSTEM_LIFECYCLE_STALE",
                            "The role navigation was cancelled before entering the native call.",
                        ));
                    }
                    if let Err(error) = surface.navigate(url.clone()) {
                        let error = RuntimeError::tauri(error);
                        self.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation,
                                "navigationSubmit",
                                NativeOperationStatus::Failed,
                                Some(error.code),
                            ),
                        );
                        return Err(error);
                    }
                    if !self.application_lifecycle_epoch_matches(lifecycle_epoch) {
                        navigation.reset();
                        self.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation,
                                "applicationLifecycleInterrupted",
                                NativeOperationStatus::Indeterminate,
                                Some("SYSTEM_LIFECYCLE_INDETERMINATE"),
                            ),
                        );
                        return Err(RuntimeError::new(
                            "SYSTEM_LIFECYCLE_INDETERMINATE",
                            "The application lifecycle changed during native role navigation.",
                        ));
                    }
                    Some(operation)
                } else {
                    if let Err(message) = navigation.adopt_current_navigation(&operation) {
                        self.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation,
                                "navigationTracker",
                                NativeOperationStatus::Failed,
                                Some("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE"),
                            ),
                        );
                        return Err(RuntimeError::new(
                            "SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE",
                            message,
                        ));
                    }
                    if self
                        .require_application_lifecycle_epoch(lifecycle_epoch)
                        .is_err()
                        || !self.operations.mark_in_flight(&operation.operation_id)
                    {
                        navigation.reset();
                        self.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation,
                                "applicationLifecycleCancelled",
                                NativeOperationStatus::Cancelled,
                                Some("SYSTEM_LIFECYCLE_SUSPENDED"),
                            ),
                        );
                        return Err(RuntimeError::new(
                            "SYSTEM_LIFECYCLE_STALE",
                            "The role navigation was cancelled before waiting for page completion.",
                        ));
                    }
                    Some(operation)
                };
                if let Err(error) = surface.set_zoom(effective_zoom) {
                    let error = RuntimeError::tauri(error);
                    if let Some(operation) = pending_operation.as_ref() {
                        navigation.reset();
                        self.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation.clone(),
                                "navigationSetup",
                                NativeOperationStatus::Failed,
                                Some(error.code),
                            ),
                        );
                    }
                    return Err(error);
                }
                if !self.application_lifecycle_epoch_matches(lifecycle_epoch) {
                    if let Some(operation) = pending_operation.as_ref() {
                        navigation.reset();
                        self.record_native_operation_receipt(
                            NativeOperationReceipt::with_status(
                                operation.clone(),
                                "applicationLifecycleInterrupted",
                                NativeOperationStatus::Indeterminate,
                                Some("SYSTEM_LIFECYCLE_INDETERMINATE"),
                            ),
                        );
                    }
                    return Err(RuntimeError::new(
                        "SYSTEM_LIFECYCLE_INDETERMINATE",
                        "The application lifecycle changed while configuring native role navigation.",
                    ));
                }
                pending_navigations.push(PendingRoleNavigation {
                    lifecycle_epoch,
                    navigation,
                    operation: pending_operation,
                    role_id: role.role_id,
                    surface,
                });
            }
            Ok(std::mem::take(&mut pending_navigations))
        })();
        if result.is_err() {
            for pending in pending_navigations {
                if let Some(operation) = pending.operation {
                    pending.navigation.reset();
                    self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                        operation,
                        "navigationBatchSetupAborted",
                        NativeOperationStatus::Superseded,
                        Some("SYSTEM_NAVIGATION_SUPERSEDED"),
                    ));
                }
            }
            self.finish_controlled_navigations(&controlled_labels);
        }
        result
    }

    fn load_roles(&self, roles: Vec<EmbeddedRoleLoadEffectRecord>) -> RuntimeResult<()> {
        let pending_navigations = self.start_role_loads(roles)?;
        let controlled_labels = pending_navigations
            .iter()
            .map(|pending| pending.surface.label().to_owned())
            .collect::<Vec<_>>();
        let mut result = Ok(());
        for pending in &pending_navigations {
            if result.is_err() {
                if let Some(operation) = pending.operation.clone() {
                    pending.navigation.reset();
                    self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                        operation,
                        "navigationBatchAborted",
                        NativeOperationStatus::Superseded,
                        Some("SYSTEM_NAVIGATION_SUPERSEDED"),
                    ));
                }
                continue;
            }
            if let Some(operation) = pending.operation.clone() {
                let receipt = pending.navigation.wait_operation(operation);
                let status = receipt.status;
                let failure_code = receipt.failure_code.clone();
                self.record_native_operation_receipt(receipt);
                if status != NativeOperationStatus::Applied {
                    result = Err(RuntimeError::new(
                        if status == NativeOperationStatus::Superseded {
                            "SYSTEM_NAVIGATION_SUPERSEDED"
                        } else {
                            "TAURI_NAVIGATION_FAILED"
                        },
                        failure_code.unwrap_or_else(|| {
                            "System WebView navigation did not complete.".to_owned()
                        }),
                    ));
                    continue;
                }
            }
            result = self.reassert_role_keys(&pending.role_id, &pending.surface);
            if result.is_ok() {
                result = self.finish_claimed_role_slot(&pending.role_id);
            }
        }
        self.finish_controlled_navigations(&controlled_labels);
        result
    }

    fn install_overlays(&self, role_ids: &[String]) -> RuntimeResult<()> {
        self.require_roles(role_ids)?;
        // The overlay is already installed as a document-start script. Readiness is reported
        // by rion_overlay_ready; launch completion never polls or waits for JavaScript.
        for role_id in role_ids {
            if let Ok(webview) = self.role_webview(role_id) {
                let _ = webview.eval(MACRO_OVERLAY_REFRESH_SOURCE);
            }
        }
        Ok(())
    }

    fn focus_role(&self, role_id: &str, zoom_factor: Option<f64>) -> RuntimeResult<()> {
        let (tab_id, webview, window_zoom_factor) = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let role = tab.roles.get(role_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            let host = state.display_hosts.get(&tab.window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
            (tab_id.clone(), role.webview.clone(), host.zoom_factor)
        };
        if let Some(zoom_factor) = zoom_factor {
            let zoom_factor = zoom_factor.clamp(0.25, 3.0);
            webview
                .set_zoom(effective_zoom_factor(zoom_factor, window_zoom_factor))
                .map_err(RuntimeError::tauri)?;
            if let Ok(mut state) = self.state()
                && let Some(tab_id) = state.role_tabs.get(role_id).cloned()
                && let Some(role_surface) = state
                    .tabs
                    .get_mut(&tab_id)
                    .and_then(|tab| tab.roles.get_mut(role_id))
            {
                role_surface.zoom_factor = zoom_factor;
                role_surface.zoom_mode = "fixed".to_owned();
            }
        }
        self.request_tab_presentation_with_window_visibility(
            &tab_id,
            NativePresentationFocus::WindowAndContent,
            "focus-role",
            Some(true),
        )
        .map(|_| ())
        .map_err(|message| RuntimeError::new("TAURI_RUNTIME_VISIBILITY_FAILED", message))
    }

}
