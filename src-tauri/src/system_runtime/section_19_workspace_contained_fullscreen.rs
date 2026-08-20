const WORKSPACE_CONTAINED_FULLSCREEN_CHANNEL_TOKEN: &str =
    "__RION_CONTAINED_FULLSCREEN_CHANNEL__";
const WORKSPACE_WEB_CHROME_HEIGHT: f64 = 34.0;
const WORKSPACE_CONTAINED_FULLSCREEN_SOURCE: &str =
    include_str!("workspace_contained_fullscreen.js");

struct WorkspaceWebChromeSurface {
    _surface_instance_id: String,
    webview: Webview,
}

struct WorkspaceWebSurface {
    capability_token: String,
    can_go_back: bool,
    can_go_forward: bool,
    chrome: WorkspaceWebChromeSurface,
    document_epoch: u64,
    document_nonce: Option<String>,
    fullscreen: bool,
    home_url: Url,
    slot_bounds: RoleBounds,
    transition_sequence: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceWebNativeNavigationAction {
    Back,
    Forward,
    Reload,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWebFullscreenReceipt {
    document_epoch: u64,
    fullscreen: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWebChromeAction {
    capability_token: String,
    document_epoch: u64,
    generation: u64,
    #[serde(rename = "type")]
    action_type: String,
    url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWebFullscreenTransition {
    capability_token: String,
    document_nonce: String,
    generation: u64,
    phase: String,
    sequence: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWebChromeState {
    can_go_back: bool,
    can_go_forward: bool,
    document_epoch: u64,
    url: String,
}

fn workspace_web_surface_bounds(
    slot: RoleBounds,
    fullscreen: bool,
) -> (RoleBounds, RoleBounds) {
    if fullscreen {
        return (
            RoleBounds {
                height: 0.0,
                width: slot.width,
                x: slot.x,
                y: slot.y,
            },
            slot,
        );
    }
    let chrome_height = WORKSPACE_WEB_CHROME_HEIGHT.min((slot.height - 1.0).max(0.0));
    (
        RoleBounds {
            height: chrome_height,
            width: slot.width,
            x: slot.x,
            y: slot.y,
        },
        RoleBounds {
            height: (slot.height - chrome_height).max(1.0),
            width: slot.width,
            x: slot.x,
            y: slot.y + chrome_height,
        },
    )
}

fn checked_workspace_chrome_url(value: &str) -> RuntimeResult<Url> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return Err(RuntimeError::new(
            "WORKSPACE_WEB_URL_INVALID",
            "Workspace Web navigation requires an HTTP(S) URL.",
        ));
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let url = Url::parse(&candidate).map_err(|_| {
        RuntimeError::new(
            "WORKSPACE_WEB_URL_INVALID",
            "Workspace Web navigation requires a valid HTTP(S) URL.",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RuntimeError::new(
            "WORKSPACE_WEB_URL_INVALID",
            "Workspace Web navigation only accepts HTTP(S) URLs.",
        ));
    }
    Ok(url)
}

fn workspace_web_chrome_state(surface: &RoleSurface) -> Option<WorkspaceWebChromeState> {
    let workspace = surface.workspace_web.as_ref()?;
    Some(WorkspaceWebChromeState {
        can_go_back: workspace.can_go_back,
        can_go_forward: workspace.can_go_forward,
        document_epoch: workspace.document_epoch,
        url: surface
            .current_url
            .as_ref()
            .unwrap_or(&workspace.home_url)
            .to_string(),
    })
}

impl SystemRuntimeExecutor {
    #[allow(clippy::too_many_arguments)]
    fn create_workspace_web_chrome_surface(
        &self,
        window: &Window,
        window_id: &str,
        tab_id: &str,
        role_id: &str,
        generation: u64,
        capability_token: String,
        home_url: Url,
        slot_bounds: RoleBounds,
    ) -> RuntimeResult<WorkspaceWebSurface> {
        let identity = serde_json::to_string(&json!({
            "capabilityToken": capability_token,
            "generation": generation,
        }))
        .map_err(|error| RuntimeError::new("WORKSPACE_WEB_IDENTITY_INVALID", error.to_string()))?;
        let initialization_script = format!(
            "Object.defineProperty(globalThis, '__rionWorkspaceWebChromeIdentity', {{ configurable: false, enumerable: false, writable: false, value: Object.freeze({identity}) }});"
        );
        let (chrome_bounds, _) = workspace_web_surface_bounds(slot_bounds, false);
        let webview = self.with_native_creation_lane(window_id, || {
            self.add_child_bounded(
                window,
                WebviewBuilder::new(
                    runtime_label("workspace-web-chrome", &format!("{tab_id}:{role_id}")),
                    WebviewUrl::App("runtime-web-chrome.html".into()),
                )
                .disable_drag_drop_handler()
                .initialization_script(&initialization_script),
                LogicalPosition::new(chrome_bounds.x, chrome_bounds.y),
                LogicalSize::new(chrome_bounds.width, chrome_bounds.height.max(1.0)),
                role_id,
            )
        })?;
        webview.hide().map_err(RuntimeError::tauri)?;
        let lifecycle = self
            .install_shared_process_surface_lifecycle_tracker(&webview)
            .inspect_err(|_| {
                let _ = webview.close();
            })?;
        let surface_instance_id = self.register_managed_surface(
            &webview,
            &lifecycle,
            ManagedSurfaceKind::WorkspaceChrome,
            ManagedSurfacePhase::Live,
            Some(role_id),
            Some(tab_id),
            window_id,
            generation,
        )?;
        if !self.presentation.bind_surface(
            window_id,
            tab_id,
            SurfacePresentationBinding {
                generation,
                instance_id: surface_instance_id.clone(),
                webview: webview.clone(),
            },
        ) {
            let _ = self.close_managed_surface_and_wait(&surface_instance_id, role_id);
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                "The Workspace Web tab closed before its chrome surface could bind.",
            ));
        }
        if let Err(message) = self.presentation.assign_surface_owner(
            webview.label(),
            &surface_instance_id,
            window_id,
        ) {
            let _ = self.close_managed_surface_and_wait(&surface_instance_id, role_id);
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                message,
            ));
        }
        self.reconcile_surface_membership(window_id, "workspace-web-chrome-attached");
        Ok(WorkspaceWebSurface {
            capability_token,
            can_go_back: false,
            can_go_forward: false,
            chrome: WorkspaceWebChromeSurface {
                _surface_instance_id: surface_instance_id,
                webview,
            },
            document_epoch: 0,
            document_nonce: None,
            fullscreen: false,
            home_url,
            slot_bounds,
            transition_sequence: 0,
        })
    }

    fn publish_workspace_web_chrome_state(&self, content_label: &str) {
        let projection = self.state.lock().ok().and_then(|state| {
            state.native_resources.tabs.values().find_map(|tab| {
                tab.roles.values().find_map(|surface| {
                    (surface.webview.label() == content_label).then(|| {
                        let state = workspace_web_chrome_state(surface)?;
                        let chrome = surface.workspace_web.as_ref()?.chrome.webview.clone();
                        Some((chrome, state))
                    })?
                })
            })
        });
        let Some((chrome, state)) = projection else {
            return;
        };
        if let Ok(serialized) = serde_json::to_string(&state) {
            let _ = chrome.eval(format!(
                "globalThis.__rionApplyWorkspaceWebChromeState?.({serialized});"
            ));
        }
    }

    fn workspace_web_navigation_event(
        &self,
        content_label: &str,
        event: PageLoadEvent,
        url: &Url,
    ) {
        let mut publish = false;
        let mut history_source = None;
        let mut restore = None;
        #[cfg(windows)]
        let mut restore_tab_id = None;
        if let Ok(mut state) = self.state.lock() {
            for tab in state.native_resources.tabs.values_mut() {
                let Some(surface) = tab
                    .roles
                    .values_mut()
                    .find(|surface| surface.webview.label() == content_label)
                else {
                    continue;
                };
                let Some(workspace) = surface.workspace_web.as_mut() else {
                    return;
                };
                match event {
                    PageLoadEvent::Started => {
                        workspace.document_epoch = workspace.document_epoch.saturating_add(1);
                        workspace.document_nonce = None;
                        if workspace.fullscreen {
                            workspace.fullscreen = false;
                            #[cfg(windows)]
                            {
                                restore_tab_id = Some(tab.tab_id.clone());
                            }
                            restore = Some((
                                surface.webview.clone(),
                                workspace.chrome.webview.clone(),
                                workspace.slot_bounds,
                            ));
                        }
                    }
                    PageLoadEvent::Finished => {
                        surface.current_url = Some(url.clone());
                        history_source = Some(surface.webview.clone());
                        publish = true;
                    }
                }
                break;
            }
        }
        if let Some((content, chrome, slot_bounds)) = restore {
            let (chrome_bounds, content_bounds) =
                workspace_web_surface_bounds(slot_bounds, false);
            let _ = content.set_bounds(tauri::Rect {
                position: LogicalPosition::new(content_bounds.x, content_bounds.y).into(),
                size: LogicalSize::new(content_bounds.width, content_bounds.height).into(),
            });
            let _ = chrome.set_bounds(tauri::Rect {
                position: LogicalPosition::new(chrome_bounds.x, chrome_bounds.y).into(),
                size: LogicalSize::new(chrome_bounds.width, chrome_bounds.height.max(1.0)).into(),
            });
            let _ = chrome.show();
        }
        #[cfg(windows)]
        if let Some(tab_id) = restore_tab_id {
            let _ = self.layout_runtime_tab_inner(&tab_id);
        }
        if let Some(content) = history_source
            && let Ok((can_go_back, can_go_forward)) =
                platform_workspace_web_history_state(&content)
            && let Ok(mut state) = self.state.lock()
            && let Some(surface) = state
                .native_resources
                .tabs
                .values_mut()
                .flat_map(|tab| tab.roles.values_mut())
                .find(|surface| surface.webview.label() == content_label)
            && let Some(workspace) = surface.workspace_web.as_mut()
        {
            workspace.can_go_back = can_go_back;
            workspace.can_go_forward = can_go_forward;
        }
        if publish {
            self.publish_workspace_web_chrome_state(content_label);
        }
    }

    pub(crate) fn workspace_web_chrome_action(
        &self,
        chrome_label: &str,
        action: WorkspaceWebChromeAction,
    ) -> RuntimeResult<WorkspaceWebChromeState> {
        let (content, content_label, navigation, native_action, target, projected) = {
            let mut state = self.state()?;
            let surface = state
                .native_resources
                .tabs
                .values_mut()
                .flat_map(|tab| tab.roles.values_mut())
                .find(|surface| {
                    surface.workspace_web.as_ref().is_some_and(|workspace| {
                        workspace.chrome.webview.label() == chrome_label
                    })
                })
                .ok_or_else(|| RuntimeError::new(
                    "WORKSPACE_WEB_CHROME_UNAUTHORIZED",
                    "Workspace Web actions are restricted to their registered local chrome surface.",
                ))?;
            let workspace = surface.workspace_web.as_mut().expect("workspace was matched");
            if workspace.capability_token != action.capability_token
                || surface.generation != action.generation
                || (action.action_type != "ready"
                    && workspace.document_epoch != action.document_epoch)
            {
                return Err(RuntimeError::new(
                    "WORKSPACE_WEB_CHROME_STALE",
                    "The Workspace Web chrome action belongs to an old surface or document.",
                ));
            }
            let target = match action.action_type.as_str() {
                "ready" => None,
                "back" | "forward" | "reload" => None,
                "home" => Some(workspace.home_url.clone()),
                "navigate" => Some(checked_workspace_chrome_url(action.url.as_deref().unwrap_or_default())?),
                _ => return Err(RuntimeError::new(
                    "WORKSPACE_WEB_CHROME_ACTION_INVALID",
                    "The Workspace Web chrome action is not supported.",
                )),
            };
            let native_action = match action.action_type.as_str() {
                "back" if workspace.can_go_back => Some(WorkspaceWebNativeNavigationAction::Back),
                "forward" if workspace.can_go_forward => {
                    Some(WorkspaceWebNativeNavigationAction::Forward)
                }
                "reload" => Some(WorkspaceWebNativeNavigationAction::Reload),
                _ => None,
            };
            (
                surface.webview.clone(),
                surface.webview.label().to_owned(),
                Arc::clone(&surface.navigation),
                native_action,
                target,
                workspace_web_chrome_state(surface).expect("workspace state exists"),
            )
        };
        if let Some(native_action) = native_action {
            self.begin_controlled_navigation(&content_label)?;
            navigation.reset();
            request_platform_workspace_web_navigation(&content, native_action)?;
        } else if let Some(target) = target {
            self.begin_controlled_navigation(&content_label)?;
            navigation.reset();
            content.navigate(target).map_err(RuntimeError::tauri)?;
        }
        Ok(projected)
    }

    pub(crate) fn workspace_web_fullscreen_transition(
        &self,
        content_label: &str,
        transition: WorkspaceWebFullscreenTransition,
    ) -> RuntimeResult<WorkspaceWebFullscreenReceipt> {
        let (content, chrome, slot_bounds, fullscreen, document_epoch, tab_id) = {
            let mut state = self.state()?;
            let (tab_id, surface) = state
                .native_resources
                .tabs
                .iter_mut()
                .find_map(|(tab_id, tab)| {
                    tab.roles
                        .values_mut()
                        .find(|surface| surface.webview.label() == content_label)
                        .map(|surface| (tab_id.clone(), surface))
                })
                .ok_or_else(|| RuntimeError::new(
                    "WORKSPACE_WEB_FULLSCREEN_UNAUTHORIZED",
                    "Contained fullscreen requests are restricted to Workspace Web content surfaces.",
                ))?;
            let workspace = surface.workspace_web.as_mut().ok_or_else(|| RuntimeError::new(
                "WORKSPACE_WEB_FULLSCREEN_UNAUTHORIZED",
                "The requesting surface does not own Workspace Web containment.",
            ))?;
            if workspace.capability_token != transition.capability_token
                || surface.generation != transition.generation
            {
                return Err(RuntimeError::new(
                    "WORKSPACE_WEB_FULLSCREEN_STALE",
                    "The contained fullscreen request belongs to an old surface generation.",
                ));
            }
            if transition.phase == "ready" {
                workspace.document_nonce = Some(transition.document_nonce);
                workspace.transition_sequence = 0;
                return Ok(WorkspaceWebFullscreenReceipt {
                    document_epoch: workspace.document_epoch,
                    fullscreen: workspace.fullscreen,
                });
            }
            if workspace.document_nonce.as_deref() != Some(transition.document_nonce.as_str())
                || transition.sequence <= workspace.transition_sequence
            {
                return Err(RuntimeError::new(
                    "WORKSPACE_WEB_FULLSCREEN_STALE",
                    "The contained fullscreen transition is stale or out of order.",
                ));
            }
            workspace.transition_sequence = transition.sequence;
            let fullscreen = match transition.phase.as_str() {
                "enter" => true,
                "exit" => false,
                _ => return Err(RuntimeError::new(
                    "WORKSPACE_WEB_FULLSCREEN_TRANSITION_INVALID",
                    "The contained fullscreen transition phase is not supported.",
                )),
            };
            (
                surface.webview.clone(),
                workspace.chrome.webview.clone(),
                workspace.slot_bounds,
                fullscreen,
                workspace.document_epoch,
                tab_id,
            )
        };
        let (chrome_bounds, content_bounds) = workspace_web_surface_bounds(slot_bounds, fullscreen);
        content
            .set_bounds(tauri::Rect {
                position: LogicalPosition::new(content_bounds.x, content_bounds.y).into(),
                size: LogicalSize::new(content_bounds.width, content_bounds.height).into(),
            })
            .map_err(RuntimeError::tauri)?;
        let chrome_result = if fullscreen {
            chrome.hide()
        } else {
            chrome
                .set_bounds(tauri::Rect {
                    position: LogicalPosition::new(chrome_bounds.x, chrome_bounds.y).into(),
                    size: LogicalSize::new(chrome_bounds.width, chrome_bounds.height.max(1.0)).into(),
                })
                .and_then(|()| chrome.show())
        };
        if let Err(error) = chrome_result {
            let (_, rollback) = workspace_web_surface_bounds(slot_bounds, !fullscreen);
            let _ = content.set_bounds(tauri::Rect {
                position: LogicalPosition::new(rollback.x, rollback.y).into(),
                size: LogicalSize::new(rollback.width, rollback.height).into(),
            });
            return Err(RuntimeError::tauri(error));
        }
        if let Ok(mut state) = self.state.lock()
            && let Some(surface) = state
                .native_resources
                .tabs
                .values_mut()
                .flat_map(|tab| tab.roles.values_mut())
                .find(|surface| surface.webview.label() == content_label)
            && let Some(workspace) = surface.workspace_web.as_mut()
        {
            workspace.fullscreen = fullscreen;
        }
        #[cfg(windows)]
        self.layout_runtime_tab_inner(&tab_id)?;
        #[cfg(not(windows))]
        let _ = tab_id;
        Ok(WorkspaceWebFullscreenReceipt {
            document_epoch,
            fullscreen,
        })
    }

    fn force_restore_workspace_web_fullscreen_for_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let surfaces = {
            let mut state = self.state()?;
            let Some(tab) = state.native_resources.tabs.get_mut(tab_id) else {
                return Ok(());
            };
            tab.roles
                .values_mut()
                .filter_map(|surface| {
                    let workspace = surface.workspace_web.as_mut()?;
                    if !workspace.fullscreen {
                        return None;
                    }
                    workspace.fullscreen = false;
                    Some((
                        surface.webview.clone(),
                        workspace.chrome.webview.clone(),
                        workspace.slot_bounds,
                    ))
                })
                .collect::<Vec<_>>()
        };
        for (content, chrome, slot_bounds) in surfaces {
            let (chrome_bounds, content_bounds) =
                workspace_web_surface_bounds(slot_bounds, false);
            content
                .set_bounds(tauri::Rect {
                    position: LogicalPosition::new(content_bounds.x, content_bounds.y).into(),
                    size: LogicalSize::new(content_bounds.width, content_bounds.height).into(),
                })
                .map_err(RuntimeError::tauri)?;
            chrome
                .set_bounds(tauri::Rect {
                    position: LogicalPosition::new(chrome_bounds.x, chrome_bounds.y).into(),
                    size: LogicalSize::new(chrome_bounds.width, chrome_bounds.height.max(1.0)).into(),
                })
                .map_err(RuntimeError::tauri)?;
            chrome.show().map_err(RuntimeError::tauri)?;
            content
                .eval(
                    "void document.exitFullscreen?.().catch(() => document.dispatchEvent(new Event('__rionWorkspaceContainedFullscreenForceExit')));",
                )
                .map_err(RuntimeError::tauri)?;
        }
        #[cfg(windows)]
        self.layout_runtime_tab_inner(tab_id)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WebviewSurfaceFeaturePolicy {
    Role,
    WorkspaceWeb,
    Utility,
}

impl WebviewSurfaceFeaturePolicy {
    fn installs_role_features(self) -> bool {
        self == Self::Role
    }

    fn installs_contained_fullscreen(self) -> bool {
        self == Self::WorkspaceWeb
    }
}

fn workspace_contained_fullscreen_script() -> String {
    WORKSPACE_CONTAINED_FULLSCREEN_SOURCE.replace(
        WORKSPACE_CONTAINED_FULLSCREEN_CHANNEL_TOKEN,
        &uuid::Uuid::new_v4().to_string(),
    )
}

fn require_workspace_contained_fullscreen_policy(
    result: RuntimeResult<()>,
) -> Result<(), RoleSurfaceSetupFailure> {
    result.map_err(|error| RoleSurfaceSetupFailure {
        error,
        lifecycle: None,
    })
}
