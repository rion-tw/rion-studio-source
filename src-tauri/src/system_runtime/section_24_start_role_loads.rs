impl SystemRuntimeExecutor {
    fn start_role_loads(
        &self,
        roles: Vec<EmbeddedRoleLoadEffectRecord>,
    ) -> RuntimeResult<Vec<(String, Webview, Arc<NavigationTracker>)>> {
        let mut pending_navigations = Vec::with_capacity(roles.len());
        let mut controlled_labels = Vec::with_capacity(roles.len());

        let result = (|| -> RuntimeResult<Vec<(String, Webview, Arc<NavigationTracker>)>> {
            for role in roles {
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
                let (surface, navigation, current_url, base_zoom_factor, effective_zoom) = {
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
                    )
                };
                let url = checked_web_url(&role.url)?;
                let controlled_label = surface.label().to_owned();
                self.begin_controlled_navigation(&controlled_label)?;
                controlled_labels.push(controlled_label);
                if current_url.as_ref() != Some(&url) {
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
                    navigation.reset();
                    surface.navigate(url.clone()).map_err(RuntimeError::tauri)?;
                }
                surface
                    .set_zoom(effective_zoom)
                    .map_err(RuntimeError::tauri)?;
                pending_navigations.push((role.role_id, surface, navigation));
            }
            Ok(pending_navigations)
        })();
        if result.is_err() {
            self.finish_controlled_navigations(&controlled_labels);
        }
        result
    }

    fn load_roles(&self, roles: Vec<EmbeddedRoleLoadEffectRecord>) -> RuntimeResult<()> {
        let pending_navigations = self.start_role_loads(roles)?;
        let controlled_labels = pending_navigations
            .iter()
            .map(|(_, surface, _)| surface.label().to_owned())
            .collect::<Vec<_>>();
        let result = pending_navigations
            .iter()
            .try_for_each(|(role_id, surface, navigation)| {
                navigation.wait().map_err(|message| {
                    let message = if self.browser_proxy.role_uses_custom_proxy(role_id) {
                        format!("{message} A custom local role proxy was active.")
                    } else {
                        message
                    };
                    RuntimeError::new("TAURI_NAVIGATION_FAILED", message)
                })?;
                self.reassert_role_keys(role_id, surface)
            });
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
        let (window, webview, window_zoom_factor) = {
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
            (host.window.clone(), role.webview.clone(), host.zoom_factor)
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
        window.show().map_err(RuntimeError::tauri)?;
        window.set_focus().map_err(RuntimeError::tauri)?;
        webview.set_focus().map_err(RuntimeError::tauri)
    }

}
