#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DesktopE2eRuntimeUiActionRequest {
    ActivateTab {
        tab_id: String,
        window_generation: u64,
    },
    FocusRole {
        role_id: String,
        tab_id: String,
        window_generation: u64,
    },
    PressRoleSlot {
        role_id: String,
        tab_id: String,
        window_generation: u64,
    },
}

impl SystemRuntimeExecutor {
    pub(crate) fn desktop_e2e_runtime_ui_action(
        &self,
        window_id: &str,
        request: DesktopE2eRuntimeUiActionRequest,
    ) -> Result<Value, String> {
        let action = desktop_e2e_runtime_ui_action_name(&request);
        let expected_generation = desktop_e2e_runtime_ui_generation(&request);
        let projection = self
            .presentation
            .live
            .kernel
            .snapshot()
            .map_err(|error| error.to_string())?
            .native_projection(window_id)
            .ok_or_else(|| format!("Native Game Window {window_id} has no live projection."))?;
        if projection.window_generation != expected_generation {
            return Err(format!(
                "Desktop E2E UI action rejected stale window generation {} (current {}).",
                expected_generation, projection.window_generation
            ));
        }

        match &request {
            DesktopE2eRuntimeUiActionRequest::ActivateTab { tab_id, .. } => {
                projection
                    .tabs
                    .iter()
                    .find(|tab| tab.tab_id == *tab_id && !tab.hidden)
                    .ok_or_else(|| "The requested visible runtime tab was not found.".to_owned())?;
                self.desktop_e2e_press_runtime_tab(window_id, expected_generation, tab_id)?;
            }
            DesktopE2eRuntimeUiActionRequest::FocusRole {
                role_id, tab_id, ..
            } => {
                desktop_e2e_require_selected_tab(&projection, tab_id, "role surface")?;
                let webview = self
                    .state()
                    .map_err(|error| error.message)?
                    .native_resources
                    .tabs
                    .get(tab_id)
                    .and_then(|tab| tab.roles.get(role_id))
                    .map(|surface| surface.webview.clone())
                    .ok_or_else(|| "The requested live role surface was not found.".to_owned())?;
                webview.set_focus().map_err(|error| error.to_string())?;
                webview
                    .eval("globalThis.focus(); const button = document.querySelector('#qa-target'); button?.focus(); button?.click();")
                    .map_err(|error| error.to_string())?;
            }
            DesktopE2eRuntimeUiActionRequest::PressRoleSlot {
                role_id, tab_id, ..
            } => {
                desktop_e2e_require_selected_tab(&projection, tab_id, "role placeholder")?;
                let placeholder = self
                    .state()
                    .map_err(|error| error.message)?
                    .native_resources
                    .tabs
                    .get(tab_id)
                    .and_then(|tab| {
                        tab.slots
                            .values()
                            .find(|slot| slot.role.id == *role_id)
                            .and_then(|slot| slot.placeholder.as_ref())
                    })
                    .map(|placeholder| placeholder.webview.clone())
                    .ok_or_else(|| "The requested live role placeholder was not found.".to_owned())?;
                placeholder
                    .eval("(() => { const button = document.querySelector('#claim'); if (!(button instanceof HTMLButtonElement) || button.disabled || button.getClientRects().length === 0) throw new Error('role claim is not visible'); button.click(); })();")
                    .map_err(|error| error.to_string())?;
            }
        }
        crate::desktop_e2e::record_event(
            "runtime-ui-action-submitted",
            Some(window_id),
            Some(expected_generation),
            Some(projection.revision),
            json!({ "action": action }),
        );
        Ok(json!({
            "action": action,
            "submitted": true,
            "windowGeneration": expected_generation,
            "windowId": window_id,
        }))
    }

    #[cfg(target_os = "macos")]
    fn desktop_e2e_press_runtime_tab(
        &self,
        window_id: &str,
        window_generation: u64,
        tab_id: &str,
    ) -> Result<(), String> {
        let controller = self
            .state()
            .map_err(|error| error.message)?
            .native_resources
            .display_hosts
            .get(window_id)
            .filter(|host| host.generation == window_generation)
            .map(|host| host.tabs_controller.clone())
            .ok_or_else(|| "The AppKit tab controller is stale or unavailable.".to_owned())?;
        controller.desktop_e2e_accessibility_press(tab_id)
    }

    #[cfg(windows)]
    fn desktop_e2e_press_runtime_tab(
        &self,
        window_id: &str,
        window_generation: u64,
        tab_id: &str,
    ) -> Result<(), String> {
        let tab_strip = self
            .state()
            .map_err(|error| error.message)?
            .native_resources
            .display_hosts
            .get(window_id)
            .filter(|host| host.generation == window_generation)
            .map(|host| host.tab_strip.clone())
            .ok_or_else(|| "The WebView2 tab strip is stale or unavailable.".to_owned())?;
        let tab_id = serde_json::to_string(tab_id).map_err(|error| error.to_string())?;
        tab_strip
            .eval(format!(
                "(() => {{ const id = {tab_id}; const button = [...document.querySelectorAll('button.tab')].find((candidate) => candidate.dataset.tabId === id); if (!button || button.hidden || button.getClientRects().length === 0) throw new Error('runtime tab is not visible'); button.click(); }})();"
            ))
            .map_err(|error| error.to_string())
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    fn desktop_e2e_press_runtime_tab(
        &self,
        _window_id: &str,
        _window_generation: u64,
        _tab_id: &str,
    ) -> Result<(), String> {
        Err("Desktop E2E runtime UI actions require macOS or Windows.".to_owned())
    }
}

fn desktop_e2e_runtime_ui_generation(request: &DesktopE2eRuntimeUiActionRequest) -> u64 {
    match request {
        DesktopE2eRuntimeUiActionRequest::ActivateTab {
            window_generation,
            ..
        }
        | DesktopE2eRuntimeUiActionRequest::FocusRole {
            window_generation,
            ..
        }
        | DesktopE2eRuntimeUiActionRequest::PressRoleSlot {
            window_generation,
            ..
        } => *window_generation,
    }
}

fn desktop_e2e_runtime_ui_action_name(request: &DesktopE2eRuntimeUiActionRequest) -> &'static str {
    match request {
        DesktopE2eRuntimeUiActionRequest::ActivateTab { .. } => "activateTab",
        DesktopE2eRuntimeUiActionRequest::FocusRole { .. } => "focusRole",
        DesktopE2eRuntimeUiActionRequest::PressRoleSlot { .. } => "pressRoleSlot",
    }
}

fn desktop_e2e_require_selected_tab(
    projection: &rion_core::RuntimeNativeProjection,
    tab_id: &str,
    target: &str,
) -> Result<(), String> {
    projection
        .tabs
        .iter()
        .any(|tab| tab.tab_id == tab_id && tab.selected)
        .then_some(())
        .ok_or_else(|| format!("The requested {target} is outside the selected tab."))
}
