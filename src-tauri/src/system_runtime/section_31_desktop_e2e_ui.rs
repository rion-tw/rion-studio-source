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
    CloseTab {
        tab_id: String,
        window_generation: u64,
    },
    DragTab {
        before_tab_id: String,
        tab_id: String,
        target_window_generation: u64,
        target_window_id: String,
        topology_revision: u64,
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
    OpenTabMenu {
        tab_id: String,
        topology_revision: u64,
        window_generation: u64,
    },
    SelectTabMenuItem {
        menu_action: String,
        tab_id: String,
        target_window_generation: Option<u64>,
        target_window_id: Option<String>,
        topology_revision: u64,
        window_generation: u64,
    },
}

impl SystemRuntimeExecutor {
    pub(crate) async fn desktop_e2e_focus_keyboard_target(
        &self,
        window_id: &str,
        window_generation: u64,
        tab_id: &str,
        role_id: &str,
    ) -> Result<(), String> {
        let projection = self
            .presentation
            .live
            .kernel
            .snapshot()
            .map_err(|error| error.to_string())?
            .native_projection(window_id)
            .ok_or_else(|| "The desktop E2E keyboard target window is no longer live.".to_owned())?;
        if projection.window_generation != window_generation {
            return Err("The desktop E2E keyboard target generation is stale.".to_owned());
        }
        desktop_e2e_require_selected_tab(&projection, tab_id, "keyboard target")?;
        let (window, webview) = {
            let state = self.state().map_err(|error| error.message)?;
            let window = state
                .native_resources
                .display_hosts
                .get(window_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| "The desktop E2E keyboard target window is unavailable.".to_owned())?;
            let webview = state
                .native_resources
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .map(|surface| surface.webview.clone())
                .ok_or_else(|| "The desktop E2E keyboard target role is unavailable.".to_owned())?;
            (window, webview)
        };
        request_platform_window_show_foreground(&window).map_err(|error| error.message)?;
        #[cfg(windows)]
        desktop_e2e_wait_for_windows_webview_focus(&webview).await?;
        #[cfg(not(windows))]
        webview.set_focus().map_err(|error| error.to_string())?;
        Ok(())
    }

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
        if let Some(expected_revision) = desktop_e2e_runtime_ui_topology_revision(&request)
            && projection.revision != expected_revision
        {
            return Err(format!(
                "Desktop E2E UI action rejected stale topology revision {} (current {}).",
                expected_revision, projection.revision
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
            DesktopE2eRuntimeUiActionRequest::CloseTab { tab_id, .. } => {
                projection
                    .tabs
                    .iter()
                    .find(|tab| tab.tab_id == *tab_id && !tab.hidden)
                    .ok_or_else(|| "The requested visible runtime tab was not found.".to_owned())?;
                self.desktop_e2e_close_runtime_tab(window_id, expected_generation, tab_id)?;
            }
            DesktopE2eRuntimeUiActionRequest::DragTab {
                before_tab_id,
                tab_id,
                target_window_generation,
                target_window_id,
                ..
            } => {
                projection
                    .tabs
                    .iter()
                    .find(|tab| tab.tab_id == *tab_id && !tab.hidden)
                    .ok_or_else(|| "The requested visible runtime tab was not found.".to_owned())?;
                let target = self
                    .presentation
                    .live
                    .kernel
                    .snapshot()
                    .map_err(|error| error.to_string())?
                    .native_projection(target_window_id)
                    .ok_or_else(|| "The target Game Window has no live projection.".to_owned())?;
                if target.window_generation != *target_window_generation {
                    return Err("The target Game Window generation is stale.".to_owned());
                }
                target
                    .tabs
                    .iter()
                    .find(|tab| tab.tab_id == *before_tab_id && !tab.hidden)
                    .ok_or_else(|| "The fenced target runtime tab is not visible.".to_owned())?;
                self.desktop_e2e_drag_runtime_tab(
                    window_id,
                    expected_generation,
                    tab_id,
                    target_window_id,
                    *target_window_generation,
                    before_tab_id,
                )?;
            }
            DesktopE2eRuntimeUiActionRequest::FocusRole {
                role_id, tab_id, ..
            } => {
                desktop_e2e_require_selected_tab(&projection, tab_id, "role surface")?;
                let (window, webview) = {
                    let state = self.state().map_err(|error| error.message)?;
                    let window = state
                        .native_resources
                        .display_hosts
                        .get(window_id)
                        .map(|host| host.window.clone())
                        .ok_or_else(|| {
                            "The requested live Game Window was not found.".to_owned()
                        })?;
                    let webview = state
                        .native_resources
                        .tabs
                        .get(tab_id)
                        .and_then(|tab| tab.roles.get(role_id))
                        .map(|surface| surface.webview.clone())
                        .ok_or_else(|| {
                            "The requested live role surface was not found.".to_owned()
                        })?;
                    (window, webview)
                };
                request_platform_window_show_foreground(&window)
                    .map_err(|error| error.message)?;
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
            DesktopE2eRuntimeUiActionRequest::OpenTabMenu { tab_id, .. } => {
                projection
                    .tabs
                    .iter()
                    .find(|tab| tab.tab_id == *tab_id && !tab.hidden)
                    .ok_or_else(|| "The requested visible runtime tab was not found.".to_owned())?;
                self.desktop_e2e_open_runtime_tab_menu(
                    window_id,
                    expected_generation,
                    tab_id,
                )?;
            }
            DesktopE2eRuntimeUiActionRequest::SelectTabMenuItem {
                menu_action,
                tab_id,
                target_window_generation,
                target_window_id,
                ..
            } => {
                projection
                    .tabs
                    .iter()
                    .find(|tab| tab.tab_id == *tab_id && !tab.hidden)
                    .ok_or_else(|| "The runtime tab menu identity is stale.".to_owned())?;
                let target_rank = if menu_action == "move" {
                    let target_window_id = target_window_id.as_deref().ok_or_else(|| {
                        "A target Game Window is required for the move menu action.".to_owned()
                    })?;
                    let target_generation = target_window_generation.ok_or_else(|| {
                        "A target Game Window generation is required for the move menu action."
                            .to_owned()
                    })?;
                    let target_projection = self
                        .presentation
                        .live
                        .kernel
                        .snapshot()
                        .map_err(|error| error.to_string())?
                        .native_projection(target_window_id)
                        .ok_or_else(|| "The target Game Window has no live projection.".to_owned())?;
                    if target_projection.window_generation != target_generation {
                        return Err("The target Game Window generation is stale.".to_owned());
                    }
                    let snapshot = self.core.app_snapshot().map_err(|error| error.to_string())?;
                    Some(
                        snapshot
                            .state
                            .game_windows
                            .iter()
                            .filter(|window| window.id != window_id)
                            .position(|window| window.id == target_window_id)
                            .ok_or_else(|| {
                                "The target Game Window is absent from the visible move menu."
                                    .to_owned()
                            })?,
                    )
                } else {
                    None
                };
                self.desktop_e2e_select_runtime_tab_menu_item(
                    window_id,
                    expected_generation,
                    menu_action,
                    target_rank,
                )?;
            }
        }
        crate::desktop_e2e::record_event(
            "runtime-ui-action-submitted",
            Some(window_id),
            Some(expected_generation),
            Some(projection.revision),
            json!({
                "action": action,
                "sourceWindowId": window_id,
                "status": "submitted",
                "tabId": desktop_e2e_runtime_ui_tab_id(&request),
                "targetWindowId": desktop_e2e_runtime_ui_target_window_id(&request),
                "topologyRevision": projection.revision,
                "windowGeneration": expected_generation,
            }),
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

    #[cfg(target_os = "macos")]
    fn desktop_e2e_close_runtime_tab(
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
        controller.desktop_e2e_accessibility_close(tab_id)
    }

    #[cfg(target_os = "macos")]
    fn desktop_e2e_drag_runtime_tab(
        &self,
        source_window_id: &str,
        source_generation: u64,
        tab_id: &str,
        target_window_id: &str,
        target_generation: u64,
        before_tab_id: &str,
    ) -> Result<(), String> {
        let (source, target) = {
            let state = self.state().map_err(|error| error.message)?;
            let source = state
                .native_resources
                .display_hosts
                .get(source_window_id)
                .filter(|host| host.generation == source_generation)
                .map(|host| host.tabs_controller.clone())
                .ok_or_else(|| "The source AppKit tab controller is stale or unavailable.".to_owned())?;
            let target = state
                .native_resources
                .display_hosts
                .get(target_window_id)
                .filter(|host| host.generation == target_generation)
                .map(|host| host.tabs_controller.clone())
                .ok_or_else(|| "The target AppKit tab controller is stale or unavailable.".to_owned())?;
            (source, target)
        };
        source.desktop_e2e_native_drag(tab_id, &target, before_tab_id)
    }

    #[cfg(target_os = "macos")]
    fn desktop_e2e_open_runtime_tab_menu(
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
        controller.desktop_e2e_accessibility_show_menu(tab_id)
    }

    #[cfg(target_os = "macos")]
    fn desktop_e2e_select_runtime_tab_menu_item(
        &self,
        _window_id: &str,
        _window_generation: u64,
        action: &str,
        target_rank: Option<usize>,
    ) -> Result<(), String> {
        crate::runtime_tabs_macos::MacRuntimeTabsController::desktop_e2e_select_menu_item(
            action,
            target_rank.unwrap_or(0),
        )
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

    #[cfg(windows)]
    fn desktop_e2e_close_runtime_tab(
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
                "(() => {{ const id = {tab_id}; const tab = [...document.querySelectorAll('button.tab')].find((candidate) => candidate.dataset.tabId === id); const close = tab?.querySelector('.close'); if (!tab || tab.hidden || tab.getClientRects().length === 0 || !close || close.getClientRects().length === 0) throw new Error('runtime tab close control is not visible'); close.click(); }})();"
            ))
            .map_err(|error| error.to_string())
    }

    #[cfg(windows)]
    fn desktop_e2e_drag_runtime_tab(
        &self,
        source_window_id: &str,
        source_generation: u64,
        tab_id: &str,
        target_window_id: &str,
        target_generation: u64,
        before_tab_id: &str,
    ) -> Result<(), String> {
        let (source_window, source_strip, target_strip) = {
            let state = self.state().map_err(|error| error.message)?;
            let source = state
                .native_resources
                .display_hosts
                .get(source_window_id)
                .filter(|host| host.generation == source_generation)
                .ok_or_else(|| "The source WebView2 tab strip is stale or unavailable.".to_owned())?;
            let target = state
                .native_resources
                .display_hosts
                .get(target_window_id)
                .filter(|host| host.generation == target_generation)
                .ok_or_else(|| "The target WebView2 tab strip is stale or unavailable.".to_owned())?;
            (
                source.window.clone(),
                source.tab_strip.clone(),
                target.tab_strip.clone(),
            )
        };
        desktop_e2e_windows_drag_runtime_tab(
            &source_window,
            &source_strip,
            tab_id,
            &target_strip,
            Some(before_tab_id),
        )
    }

    #[cfg(windows)]
    fn desktop_e2e_open_runtime_tab_menu(
        &self,
        window_id: &str,
        window_generation: u64,
        tab_id: &str,
    ) -> Result<(), String> {
        let (window, tab_strip) = {
            let state = self.state().map_err(|error| error.message)?;
            let host = state
                .native_resources
                .display_hosts
                .get(window_id)
                .filter(|host| host.generation == window_generation)
                .ok_or_else(|| "The WebView2 tab strip is stale or unavailable.".to_owned())?;
            (host.window.clone(), host.tab_strip.clone())
        };
        desktop_e2e_windows_click_runtime_tab(&window, &tab_strip, tab_id, true)
    }

    #[cfg(windows)]
    fn desktop_e2e_select_runtime_tab_menu_item(
        &self,
        window_id: &str,
        window_generation: u64,
        action: &str,
        target_rank: Option<usize>,
    ) -> Result<(), String> {
        let owner = self
            .state()
            .map_err(|error| error.message)?
            .native_resources
            .display_hosts
            .get(window_id)
            .filter(|host| host.generation == window_generation)
            .map(|host| host.window.clone())
            .ok_or_else(|| "The WebView2 menu owner is stale or unavailable.".to_owned())?;
        desktop_e2e_windows_arm_tab_menu_item(&owner, window_id, action, target_rank)
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

    #[cfg(not(any(windows, target_os = "macos")))]
    fn desktop_e2e_close_runtime_tab(
        &self,
        _window_id: &str,
        _window_generation: u64,
        _tab_id: &str,
    ) -> Result<(), String> {
        Err("Desktop E2E runtime UI actions require macOS or Windows.".to_owned())
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    fn desktop_e2e_drag_runtime_tab(
        &self,
        _source_window_id: &str,
        _source_generation: u64,
        _tab_id: &str,
        _target_window_id: &str,
        _target_generation: u64,
        _before_tab_id: &str,
    ) -> Result<(), String> {
        Err("Desktop E2E runtime UI actions require macOS or Windows.".to_owned())
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    fn desktop_e2e_open_runtime_tab_menu(
        &self,
        _window_id: &str,
        _window_generation: u64,
        _tab_id: &str,
    ) -> Result<(), String> {
        Err("Desktop E2E runtime UI actions require macOS or Windows.".to_owned())
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    fn desktop_e2e_select_runtime_tab_menu_item(
        &self,
        _window_id: &str,
        _window_generation: u64,
        _action: &str,
        _target_rank: Option<usize>,
    ) -> Result<(), String> {
        Err("Desktop E2E runtime UI actions require macOS or Windows.".to_owned())
    }
}

#[cfg(windows)]
async fn desktop_e2e_wait_for_windows_webview_focus(webview: &Webview) -> Result<(), String> {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };
    use webview2_com::{
        FocusChangedEventHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let sender = Rc::new(RefCell::new(Some(sender)));
            let registration_token = Rc::new(Cell::new(0_i64));
            let callback_sender = Rc::clone(&sender);
            let callback_token = Rc::clone(&registration_token);
            let handler = FocusChangedEventHandler::create(Box::new(move |controller, _| {
                if let Some(controller) = controller {
                    let token = callback_token.replace(0);
                    if token != 0 {
                        let _ = controller.remove_GotFocus(token);
                    }
                }
                if let Some(sender) = callback_sender.borrow_mut().take() {
                    let _ = sender.send(Ok(()));
                }
                Ok(())
            }));
            let result = (|| -> Result<(), String> {
                let mut token = 0;
                controller
                    .add_GotFocus(&handler, &mut token)
                    .map_err(|error| error.to_string())?;
                registration_token.set(token);
                // Clear the UI thread's current target so MoveFocus always creates a
                // fresh WebView2 focus acknowledgement, even when the role already
                // owned focus before this input sequence.
                let _ = SetFocus(None);
                controller
                    .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
                    .map_err(|error| error.to_string())
            })();
            if let Err(error) = result {
                let token = registration_token.replace(0);
                if token != 0 {
                    let _ = controller.remove_GotFocus(token);
                }
                if let Some(sender) = sender.borrow_mut().take() {
                    let _ = sender.send(Err(error));
                }
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "The WebView2 focus acknowledgement was interrupted.".to_owned())?
}

fn desktop_e2e_runtime_ui_generation(request: &DesktopE2eRuntimeUiActionRequest) -> u64 {
    match request {
        DesktopE2eRuntimeUiActionRequest::ActivateTab {
            window_generation,
            ..
        }
        | DesktopE2eRuntimeUiActionRequest::CloseTab {
            window_generation,
            ..
        }
        | DesktopE2eRuntimeUiActionRequest::DragTab {
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
        }
        | DesktopE2eRuntimeUiActionRequest::OpenTabMenu {
            window_generation,
            ..
        }
        | DesktopE2eRuntimeUiActionRequest::SelectTabMenuItem {
            window_generation,
            ..
        } => *window_generation,
    }
}

fn desktop_e2e_runtime_ui_action_name(request: &DesktopE2eRuntimeUiActionRequest) -> &'static str {
    match request {
        DesktopE2eRuntimeUiActionRequest::ActivateTab { .. } => "activateTab",
        DesktopE2eRuntimeUiActionRequest::CloseTab { .. } => "closeTab",
        DesktopE2eRuntimeUiActionRequest::DragTab { .. } => "dragTab",
        DesktopE2eRuntimeUiActionRequest::FocusRole { .. } => "focusRole",
        DesktopE2eRuntimeUiActionRequest::PressRoleSlot { .. } => "pressRoleSlot",
        DesktopE2eRuntimeUiActionRequest::OpenTabMenu { .. } => "openTabMenu",
        DesktopE2eRuntimeUiActionRequest::SelectTabMenuItem { .. } => "selectTabMenuItem",
    }
}

fn desktop_e2e_runtime_ui_topology_revision(
    request: &DesktopE2eRuntimeUiActionRequest,
) -> Option<u64> {
    match request {
        DesktopE2eRuntimeUiActionRequest::DragTab {
            topology_revision, ..
        }
        | DesktopE2eRuntimeUiActionRequest::OpenTabMenu {
            topology_revision, ..
        }
        | DesktopE2eRuntimeUiActionRequest::SelectTabMenuItem {
            topology_revision, ..
        } => Some(*topology_revision),
        _ => None,
    }
}

fn desktop_e2e_runtime_ui_tab_id(
    request: &DesktopE2eRuntimeUiActionRequest,
) -> Option<&str> {
    match request {
        DesktopE2eRuntimeUiActionRequest::ActivateTab { tab_id, .. }
        | DesktopE2eRuntimeUiActionRequest::CloseTab { tab_id, .. }
        | DesktopE2eRuntimeUiActionRequest::DragTab { tab_id, .. }
        | DesktopE2eRuntimeUiActionRequest::FocusRole { tab_id, .. }
        | DesktopE2eRuntimeUiActionRequest::PressRoleSlot { tab_id, .. }
        | DesktopE2eRuntimeUiActionRequest::OpenTabMenu { tab_id, .. }
        | DesktopE2eRuntimeUiActionRequest::SelectTabMenuItem { tab_id, .. } => Some(tab_id),
    }
}

fn desktop_e2e_runtime_ui_target_window_id(
    request: &DesktopE2eRuntimeUiActionRequest,
) -> Option<&str> {
    match request {
        DesktopE2eRuntimeUiActionRequest::DragTab {
            target_window_id, ..
        } => Some(target_window_id),
        DesktopE2eRuntimeUiActionRequest::SelectTabMenuItem {
            target_window_id, ..
        } => target_window_id.as_deref(),
        _ => None,
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
