#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTabFailureStatusProjection {
    body: String,
    identity: RuntimeTabStatusIdentityRecord,
    language: String,
    retry_label: String,
    tab_name: String,
    theme: String,
    title: String,
}

impl SystemRuntimeExecutor {
    #[cfg(windows)]
    fn runtime_tab_failure_status_projection(
        &self,
        window_id: &str,
    ) -> Option<RuntimeTabFailureStatusProjection> {
        let identity = self.active_failed_tab_status_identity(window_id)?;
        let tab_name = self
            .presentation
            .tab(window_id, &identity.tab_id)
            .map(|tab| tab.title)
            .unwrap_or_else(|| identity.tab_id.clone());
        let language = self
            .language
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "en".to_owned());
        let labels = runtime_tab_failure_labels(&language, &tab_name);
        let theme = self
            .resolved_theme
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "light".to_owned());
        Some(RuntimeTabFailureStatusProjection {
            body: labels.body.to_owned(),
            identity,
            language,
            retry_label: labels.retry.to_owned(),
            tab_name,
            theme,
            title: labels.title,
        })
    }

    pub(crate) fn hide_runtime_tab_failure_status(&self, window_id: &str) {
        #[cfg(target_os = "macos")]
        if let Some(controller) = self.state.lock().ok().and_then(|state| {
            state
                .native_resources
                .display_hosts
                .get(window_id)
                .map(|host| host.tabs_controller.clone())
        }) {
            controller.hide_failure_status();
        }
        #[cfg(windows)]
        if let Some(webview) = self.state.lock().ok().and_then(|state| {
            state
                .native_resources
                .display_hosts
                .get(window_id)
                .and_then(|host| host.tab_failure_status.as_ref())
                .map(|status| status.webview.clone())
        }) {
            let _ = webview.hide();
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = window_id;
    }

    #[cfg(windows)]
    fn sync_windows_tab_failure_status_surfaces(&self) {
        let window_ids = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .native_resources
                    .display_hosts
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for window_id in window_ids {
            let Some(projection) = self.runtime_tab_failure_status_projection(&window_id) else {
                self.hide_runtime_tab_failure_status(&window_id);
                continue;
            };
            if let Some(status) = self.state.lock().ok().and_then(|state| {
                state
                    .native_resources
                    .display_hosts
                    .get(&window_id)
                    .and_then(|host| host.tab_failure_status.as_ref())
                    .map(|status| status.webview.clone())
            }) {
                self.apply_windows_tab_failure_status_projection(&status, &projection);
                continue;
            }
            let should_create = self.state.lock().ok().is_some_and(|mut state| {
                let Some(host) = state.native_resources.display_hosts.get_mut(&window_id) else {
                    return false;
                };
                if host.tab_failure_status.is_some() || host.tab_failure_status_creating {
                    return false;
                }
                host.tab_failure_status_creating = true;
                true
            });
            if should_create {
                self.create_windows_tab_failure_status_surface(&window_id, projection);
            }
        }
    }

    #[cfg(windows)]
    fn create_windows_tab_failure_status_surface(
        &self,
        window_id: &str,
        projection: RuntimeTabFailureStatusProjection,
    ) {
        let Some((window, generation)) = self.state.lock().ok().and_then(|state| {
            state
                .native_resources
                .display_hosts
                .get(window_id)
                .map(|host| (host.window.clone(), host.generation))
        }) else {
            return;
        };
        let result = (|| -> RuntimeResult<Webview> {
            let metrics = runtime_window_content_metrics(&window)?;
            let payload = serde_json::to_string(&projection).map_err(|error| {
                RuntimeError::new("TAURI_RUNTIME_TAB_STATUS_INVALID", error.to_string())
            })?;
            let initialization_script = format!(
                "Object.defineProperty(globalThis, '__rionInitialRuntimeTabFailureStatus', {{ configurable: false, enumerable: false, writable: false, value: Object.freeze({payload}) }});"
            );
            let background = if projection.theme == "dark" {
                tauri::utils::config::Color(31, 31, 31, 255)
            } else {
                tauri::utils::config::Color(246, 246, 246, 255)
            };
            let builder = WebviewBuilder::new(
                runtime_label("game-tab-status", &format!("{window_id}:{generation}")),
                WebviewUrl::App("runtime-tab-status.html".into()),
            )
            .disable_drag_drop_handler()
            .background_color(background)
            .initialization_script(&initialization_script);
            self.add_child_bounded(
                &window,
                builder,
                LogicalPosition::new(0.0, metrics.top_inset),
                LogicalSize::new(metrics.width, metrics.height),
                &format!("{window_id}:tab-failure-status"),
            )
        })();
        let mut inserted = None;
        if let Ok(webview) = result.as_ref()
            && self.failed_tab_status_identity_is_current(&projection.identity)
            && let Ok(mut state) = self.state()
            && let Some(host) = state.native_resources.display_hosts.get_mut(window_id)
            && host.generation == generation
        {
            host.tab_failure_status = Some(RuntimeTabFailureStatusSurface {
                webview: webview.clone(),
            });
            inserted = Some(webview.clone());
        }
        if let Ok(mut state) = self.state()
            && let Some(host) = state.native_resources.display_hosts.get_mut(window_id)
            && host.generation == generation
        {
            host.tab_failure_status_creating = false;
        }
        match (result, inserted) {
            (Ok(webview), Some(status)) => {
                self.apply_windows_tab_failure_status_projection(&status, &projection);
                let _ = webview.show();
            }
            (Ok(webview), None) => {
                let _ = webview.close();
            }
            (Err(error), _) => {
                eprintln!(
                    "Windows runtime tab failure status surface could not be created: window={window_id} error={}",
                    error.message
                );
            }
        }
    }

    #[cfg(windows)]
    fn apply_windows_tab_failure_status_projection(
        &self,
        webview: &Webview,
        projection: &RuntimeTabFailureStatusProjection,
    ) {
        if !self.failed_tab_status_identity_is_current(&projection.identity) {
            let _ = webview.hide();
            return;
        }
        if let Some(window) = self.window_for_id(&projection.identity.window_id)
            && let Ok(metrics) = runtime_window_content_metrics(&window)
        {
            let _ = webview.set_bounds(tauri::Rect {
                position: LogicalPosition::new(0.0, metrics.top_inset).into(),
                size: LogicalSize::new(metrics.width, metrics.height).into(),
            });
        }
        if let Ok(payload) = serde_json::to_string(projection) {
            let _ = webview.eval(format!(
                "globalThis.__rionApplyRuntimeTabFailureStatus?.({payload});"
            ));
        }
        let _ = webview.show();
    }
}
