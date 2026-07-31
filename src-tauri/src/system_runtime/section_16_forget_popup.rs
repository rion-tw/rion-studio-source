impl SystemRuntimeExecutor {
    pub(crate) fn forget_popup(&self, window_label: &str) {
        let (role_id, released_surfaces) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let released_surfaces = state
                .surface_registry
                .values()
                .filter(|surface| {
                    surface.kind == ManagedSurfaceKind::Popup
                        && surface.webview.label() == window_label
                })
                .map(|surface| (surface.instance_id.clone(), Arc::clone(&surface.lifecycle)))
                .collect::<Vec<_>>();
            let role_id = state.popup_roles.remove(window_label);
            state.audible_webviews.remove(window_label);
            state.overlay_capabilities.remove(window_label);
            state
                .close_coordinator
                .closing_webviews
                .remove(window_label);
            (role_id, released_surfaces)
        };
        let platform = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "other"
        };
        for (instance_id, lifecycle) in released_surfaces {
            lifecycle.mark_controller_released();
            #[cfg(windows)]
            lifecycle.mark_native_surface_released();
            if lifecycle.wait_for_controller_release(platform, Duration::ZERO) {
                let _ = self.remove_managed_surface(&instance_id);
            }
        }
        let Some(role_id) = role_id else {
            return;
        };
        let core = Arc::clone(&self.core);
        let app = self.app.clone();
        let window_label = window_label.to_owned();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = core
                .invoke_async(CoreCommand::MacroReleaseRole {
                    role_id: role_id.clone(),
                })
                .await
            {
                let _ = app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "SYSTEM_POPUP_MACRO_RELEASE_FAILED",
                        "message": format!("Could not release popup-owned macro input: {error}"),
                        "roleId": role_id,
                        "windowLabel": window_label
                    }),
                );
            }
        });
        self.publish_projection();
    }

    fn allow_navigation_after_macro_release(
        &self,
        webview_label: &str,
        role_id: &str,
        url: &Url,
    ) -> bool {
        if !matches!(url.scheme(), "about" | "http" | "https") {
            return false;
        }
        if should_release_macros_for_navigation(url) && !cfg!(windows) {
            // WRY's WKNavigationDelegate callback does not expose targetFrame.
            // Preserve the original request and frame while releasing input
            // asynchronously, matching the existing macOS behavior.
            self.release_macros_for_unblocked_navigation(webview_label, role_id);
        }
        true
    }

    fn release_macros_for_unblocked_navigation(&self, webview_label: &str, role_id: &str) {
        let app = self.app.clone();
        let core = Arc::clone(&self.core);
        let role_id = role_id.to_owned();
        let webview_label = webview_label.to_owned();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = core
                .invoke_async(CoreCommand::MacroReleaseRole {
                    role_id: role_id.clone(),
                })
                .await
            {
                let _ = app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "SYSTEM_NAVIGATION_MACRO_RELEASE_FAILED",
                        "message": format!("Macro input could not be released after navigation started: {error}"),
                        "roleId": role_id,
                        "webviewLabel": webview_label
                    }),
                );
            }
        });
    }

    #[cfg(windows)]
    fn should_defer_windows_document_navigation(&self, webview_label: &str) -> bool {
        self.state.lock().is_ok_and(|state| {
            should_defer_document_navigation(
                "windows",
                state.controlled_navigation_webviews.contains(webview_label),
            )
        })
    }

    fn begin_controlled_navigation(&self, webview_label: &str) -> RuntimeResult<()> {
        self.state()?
            .controlled_navigation_webviews
            .insert(webview_label.to_owned());
        Ok(())
    }

    fn finish_controlled_navigations(&self, webview_labels: &[String]) {
        if let Ok(mut state) = self.state.lock() {
            for label in webview_labels {
                state.controlled_navigation_webviews.remove(label);
            }
        }
    }

    fn register_popup(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        window_label: String,
        role_id: String,
        generation: u64,
    ) -> RuntimeResult<()> {
        let (tab_id, window_id, effective_zoom) = {
            let mut state = self.state()?;
            let tab_id = state.role_tabs.get(&role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found while registering its popup.",
                )
            })?;
            let tab = state.tabs.get(&tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_TAB_NOT_FOUND",
                    "Runtime tab was not found while registering its popup.",
                )
            })?;
            let role_zoom = tab
                .roles
                .get(&role_id)
                .map(|role| role.zoom_factor)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role surface was not found while registering its popup.",
                    )
                })?;
            let window_id = tab.window_id.clone();
            let window_zoom = state
                .display_hosts
                .get(&window_id)
                .map(|host| host.zoom_factor)
                .unwrap_or(1.0);
            state
                .popup_roles
                .insert(window_label.clone(), role_id.clone());
            (
                tab_id,
                window_id,
                effective_zoom_factor(role_zoom, window_zoom),
            )
        };
        if let Err(error) = self.register_managed_surface(
            webview,
            lifecycle,
            ManagedSurfaceKind::Popup,
            ManagedSurfacePhase::Live,
            Some(&role_id),
            Some(&tab_id),
            &window_id,
            generation,
        ) {
            if let Ok(mut state) = self.state.lock() {
                state.popup_roles.remove(&window_label);
            }
            return Err(error);
        }
        webview
            .set_zoom(effective_zoom)
            .map_err(RuntimeError::tauri)
    }

    fn schedule_surface_recovery(
        self: &Arc<Self>,
        role_id: String,
        reason: String,
        generation: u64,
    ) {
        if !self.health.is_healthy() {
            return;
        }
        let allowed = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.close_coordinator.closing_roles.contains(&role_id)
                || state.close_coordinator.quarantined_roles.contains(&role_id)
            {
                return;
            }
            let Some(tab_id) = state.role_tabs.get(&role_id) else {
                return;
            };
            let Some(surface_generation) = state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(&role_id))
                .map(|surface| surface.generation)
            else {
                return;
            };
            if !claim_surface_recovery(
                surface_generation,
                generation,
                &mut state.recovering_roles,
                &role_id,
            ) {
                return;
            }
            let now = Instant::now();
            let budget = state
                .recovery_budgets
                .entry(role_id.clone())
                .or_insert(RecoveryBudget {
                    attempts: 0,
                    window_started: now,
                });
            budget.claim(now)
        };
        let queued = self.effect_sender.get().ok_or(()).and_then(|sender| {
            sender
                .send(SystemRuntimeWork::RecoverSurface {
                    allowed,
                    reason: reason.clone(),
                    role_id: role_id.clone(),
                })
                .map_err(|_| ())
        });
        if queued.is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            let _ = self.app.emit(
                "rion://shell-error",
                json!({
                    "code": "SYSTEM_SURFACE_RECOVERY_QUEUE_UNAVAILABLE",
                    "message": "The System WebView recovery queue is unavailable. Restart Rion Studio to recover safely.",
                    "roleId": role_id,
                    "reason": reason
                }),
            );
        }
    }

    fn recover_system_surface(&self, role_id: String, reason: String, allowed: bool) {
        if self.state.lock().ok().is_some_and(|mut state| {
            let fenced = state.close_coordinator.closing_roles.contains(&role_id)
                || state.close_coordinator.quarantined_roles.contains(&role_id);
            if fenced {
                state.recovering_roles.remove(&role_id);
            }
            fenced
        }) {
            return;
        }
        self.clear_role_keys(&role_id);
        let _ = self.core.invoke(CoreCommand::EmbeddedSystemSurfaceFailed {
            role_id: role_id.clone(),
            reason: Some(reason.clone()),
        });
        let result = if allowed {
            self.rebuild_role_surface(&role_id)
        } else {
            Err(RuntimeError::new(
                "SYSTEM_SURFACE_RECOVERY_EXHAUSTED",
                "System WebView recovery was stopped after two failures within 60 seconds.",
            ))
        };
        match result {
            Ok(()) => {
                let _ = self
                    .core
                    .invoke(CoreCommand::EmbeddedSystemSurfaceRecovered {
                        role_id: role_id.clone(),
                    });
                self.publish_projection();
            }
            Err(error) => {
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": error.code,
                        "message": error.message,
                        "roleId": role_id,
                        "reason": reason
                    }),
                );
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.recovering_roles.remove(&role_id);
        }
    }

}
