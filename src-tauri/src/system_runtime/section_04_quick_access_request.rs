#[derive(Clone, Debug, PartialEq, Eq)]
enum QuickAccessOrigin {
    RuntimeTab { tab_id: String },
    Popup { role_id: String, webview_label: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct QuickAccessRequestEntry {
    consumed: bool,
    origin: QuickAccessOrigin,
    request_id: String,
}

#[derive(Default)]
struct QuickAccessRequestLedger {
    current: Option<QuickAccessRequestEntry>,
}

impl QuickAccessRequestLedger {
    fn begin(&mut self, origin: QuickAccessOrigin) -> Value {
        let request_id = uuid::Uuid::new_v4().to_string();
        self.current = Some(QuickAccessRequestEntry {
            consumed: false,
            origin,
            request_id: request_id.clone(),
        });
        json!({ "requestId": request_id })
    }

    fn consume(&mut self) -> Option<Value> {
        let request = self.current.as_mut()?;
        if request.consumed {
            return None;
        }
        request.consumed = true;
        Some(json!({ "requestId": request.request_id }))
    }

    fn is_presentable(&self, request_id: &str) -> bool {
        self.current
            .as_ref()
            .is_some_and(|request| request.request_id == request_id && request.consumed)
    }

    fn resolve(&mut self, request_id: &str) -> Option<QuickAccessOrigin> {
        if self
            .current
            .as_ref()
            .is_none_or(|request| request.request_id != request_id)
        {
            return None;
        }
        self.current.take().map(|request| request.origin)
    }
}

impl RuntimeState {
    fn quick_access_origin_for_webview(&self, webview_label: &str) -> Option<QuickAccessOrigin> {
        if self.close_coordinator.closing_webviews.contains(webview_label) {
            return None;
        }
        if let Some(role_id) = self.popup_roles.get(webview_label) {
            return (!self.close_coordinator.closing_roles.contains(role_id)).then(|| {
                QuickAccessOrigin::Popup {
                    role_id: role_id.clone(),
                    webview_label: webview_label.to_owned(),
                }
            });
        }
        self.native_resources.tabs.iter().find_map(|(tab_id, tab)| {
            tab.roles
                .values()
                .any(|surface| surface.webview.label() == webview_label)
                .then(|| QuickAccessOrigin::RuntimeTab {
                    tab_id: tab_id.clone(),
                })
        })
    }
}

impl SystemRuntimeExecutor {
    pub(crate) fn request_quick_access_from_webview(&self, webview_label: &str) -> bool {
        let (request, origin) = {
            let Ok(mut state) = self.state.lock() else {
                return false;
            };
            let Some(origin) = state.quick_access_origin_for_webview(webview_label) else {
                return false;
            };
            let request = state.quick_access_requests.begin(origin.clone());
            (request, origin)
        };
        #[cfg(feature = "desktop-e2e")]
        self.record_desktop_e2e_quick_access_request(&origin, webview_label);
        #[cfg(not(feature = "desktop-e2e"))]
        let _ = origin;
        self.app.emit("rion://quick-access-request", request).is_ok()
    }

    #[cfg(feature = "desktop-e2e")]
    fn record_desktop_e2e_quick_access_request(
        &self,
        origin: &QuickAccessOrigin,
        webview_label: &str,
    ) {
        let (tab_id, window_id, origin_kind) = match origin {
            QuickAccessOrigin::RuntimeTab { tab_id } => (
                Some(tab_id.as_str()),
                self.presentation.tab_window(tab_id).ok().flatten(),
                "runtimeTab",
            ),
            QuickAccessOrigin::Popup { .. } => (None, None, "popup"),
        };
        crate::desktop_e2e::record_event(
            "game-quick-access-requested",
            window_id.as_deref(),
            None,
            None,
            json!({
                "origin": origin_kind,
                "tabId": tab_id,
                "webviewLabel": webview_label,
            }),
        );
    }

    pub fn take_quick_access_request(&self) -> Option<Value> {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.quick_access_requests.consume())
    }

    pub fn present_quick_access_request(&self, request_id: &str) -> Result<bool, String> {
        if !self.quick_access_request_is_presentable(request_id) {
            return Ok(false);
        }
        self.show_main_window(true, "game-quick-access")
            .map_err(|error| error.message)?;
        Ok(self.quick_access_request_is_presentable(request_id))
    }

    pub fn resolve_quick_access_request(
        &self,
        request_id: &str,
        resolution: &str,
    ) -> Result<(), String> {
        let origin = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .quick_access_requests
            .resolve(request_id);
        #[cfg(feature = "desktop-e2e")]
        crate::desktop_e2e::record_event(
            "game-quick-access-resolved",
            None,
            None,
            None,
            json!({
                "hadOrigin": origin.is_some(),
                "requestId": request_id,
                "resolution": resolution,
            }),
        );
        if resolution != "cancel" {
            return Ok(());
        }
        let Some(origin) = origin else {
            return Ok(());
        };
        self.restore_quick_access_origin(origin)
    }

    fn quick_access_request_is_presentable(&self, request_id: &str) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.quick_access_requests.is_presentable(request_id))
    }

    fn restore_quick_access_origin(&self, origin: QuickAccessOrigin) -> Result<(), String> {
        match origin {
            QuickAccessOrigin::RuntimeTab { tab_id } => {
                if !self
                    .state
                    .lock()
                    .is_ok_and(|state| state.native_resources.tabs.contains_key(&tab_id))
                {
                    return Ok(());
                }
                let window_id = self.resolve_live_presentation_tab_owner(&tab_id)?;
                let Some(window) = self.window_for_id(&window_id) else {
                    return Ok(());
                };
                request_platform_window_show_foreground(&window)
                    .map_err(|error| error.message)?;
                self.request_tab_presentation_with_window_visibility(
                    &tab_id,
                    NativePresentationFocus::ContentOnly,
                    "quick-access-cancel",
                    Some(true),
                )
                .map(|_| ())
            }
            QuickAccessOrigin::Popup {
                role_id,
                webview_label,
            } => {
                let still_owned = self.state.lock().is_ok_and(|state| {
                    state.popup_roles.get(&webview_label).map(String::as_str)
                        == Some(role_id.as_str())
                });
                if !still_owned {
                    return Ok(());
                }
                let Some(webview) = self.app.get_webview(&webview_label) else {
                    return Ok(());
                };
                if let Some(window) = self.app.get_webview_window(&webview_label) {
                    window.show().map_err(|error| error.to_string())?;
                    window.set_focus().map_err(|error| error.to_string())?;
                }
                self.focus_selected_overlay_webview(&webview, &role_id)
                    .map_err(|error| error.message)
            }
        }
    }
}
