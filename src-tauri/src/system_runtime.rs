use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

use rion_core::{
    BrowserRuntimeSnapshot, CoreEffectAction, CoreEffectRequest, CoreEffectResult,
    EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord, EmbeddedTabEffectRecord,
    EngineCapabilitySnapshotRecord, EngineCapabilityStatus, ResolvedBrowserEngine,
    SystemWebViewRuntimeRegistrationRecord,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl, Window,
    webview::{PageLoadEvent, WebviewBuilder},
    window::WindowBuilder,
};

const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(40);
const SYSTEM_RUNTIME_INIT_SCRIPT: &str = r#"
Object.defineProperty(window, "__rionSystemWebView", {
  configurable: false,
  enumerable: false,
  value: Object.freeze({ version: 1 })
});
"#;

#[derive(Default)]
struct NavigationState {
    finished: bool,
    started: bool,
}

#[derive(Default)]
struct NavigationTracker {
    state: Mutex<NavigationState>,
    changed: Condvar,
}

impl NavigationTracker {
    fn reset(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.finished = false;
            state.started = false;
        }
    }

    fn page_event(&self, event: PageLoadEvent) {
        if let Ok(mut state) = self.state.lock() {
            match event {
                PageLoadEvent::Started => state.started = true,
                PageLoadEvent::Finished if state.started => state.finished = true,
                PageLoadEvent::Finished => {}
            }
            self.changed.notify_all();
        }
    }

    fn wait(&self) -> Result<(), String> {
        let deadline = Instant::now() + NAVIGATION_TIMEOUT;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "navigation tracker lock poisoned".to_owned())?;
        while !state.finished {
            let now = Instant::now();
            if now >= deadline {
                return Err("System WebView navigation timed out.".to_owned());
            }
            let (next, timeout) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| "navigation tracker lock poisoned".to_owned())?;
            state = next;
            if timeout.timed_out() && !state.finished {
                return Err("System WebView navigation timed out.".to_owned());
            }
        }
        Ok(())
    }
}

struct RoleSurface {
    navigation: Arc<NavigationTracker>,
    webview: Webview,
}

struct RuntimeTab {
    display_id: i64,
    roles: HashMap<String, RoleSurface>,
    target: EmbeddedLaunchTargetRecord,
    window: Window,
}

#[derive(Default)]
struct RuntimeState {
    role_tabs: HashMap<String, String>,
    tabs: HashMap<String, RuntimeTab>,
}

pub struct SystemRuntimeExecutor {
    app: AppHandle,
    state: Mutex<RuntimeState>,
    user_data_dir: PathBuf,
}

impl SystemRuntimeExecutor {
    pub fn new(app: AppHandle, user_data_dir: PathBuf) -> Self {
        Self {
            app,
            state: Mutex::new(RuntimeState::default()),
            user_data_dir,
        }
    }

    pub fn registration(&self) -> SystemWebViewRuntimeRegistrationRecord {
        let platform = if cfg!(target_os = "macos") {
            rion_platform::Platform::Macos
        } else {
            rion_platform::Platform::Windows
        };
        let probe = rion_platform::probe_system_webview(platform);
        let available = probe.available && probe.audio_mute_available;
        SystemWebViewRuntimeRegistrationRecord {
            platform: if cfg!(target_os = "macos") {
                "macos".to_owned()
            } else {
                "windows".to_owned()
            },
            engine: if cfg!(target_os = "macos") {
                ResolvedBrowserEngine::Wkwebview
            } else {
                ResolvedBrowserEngine::Webview2
            },
            adapter_version: format!("tauri-wry-{}", env!("CARGO_PKG_VERSION")),
            available,
            capability_snapshot: EngineCapabilitySnapshotRecord {
                navigation: supported_if(available),
                persistent_session: supported_if(available),
                trusted_input: EngineCapabilityStatus::Unsupported,
                background_input: EngineCapabilityStatus::Unsupported,
                frame_evaluation: if available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                cdn_rewrite: EngineCapabilityStatus::Unsupported,
                proxy: EngineCapabilityStatus::Unsupported,
                popup: EngineCapabilityStatus::Unsupported,
                audio_mute: supported_if(available),
                custom_fonts: EngineCapabilityStatus::Unsupported,
                graphics_tuning: if available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                downloads: EngineCapabilityStatus::Unsupported,
                file_upload: if available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                permissions: if available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                dialogs: if available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                certificate_handling: supported_if(available),
            },
            failure_reason: (!available).then_some(if cfg!(target_os = "macos") {
                rion_core::EngineFallbackReason::WebkitSpiUnavailable
            } else {
                rion_core::EngineFallbackReason::RuntimeCreationFailed
            }),
        }
    }

    pub fn execute(&self, effect: CoreEffectRequest) -> CoreEffectResult {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        match self.apply(effect) {
            Ok(value_json) => CoreEffectResult {
                effect_id,
                operation_id,
                ok: true,
                value_json,
                error: None,
            },
            Err(error) => CoreEffectResult {
                effect_id,
                operation_id,
                ok: false,
                value_json: None,
                error: Some(rion_core::CoreErrorPayload {
                    code: error.code.to_owned(),
                    message: error.message,
                }),
            },
        }
    }

    pub fn close_all(&self) {
        if let Ok(mut state) = self.state.lock() {
            let tabs = std::mem::take(&mut state.tabs);
            state.role_tabs.clear();
            drop(state);
            for (_, tab) in tabs {
                let _ = tab.window.close();
            }
        }
    }

    pub fn projection(&self, snapshot: &BrowserRuntimeSnapshot) -> Value {
        let Ok(state) = self.state.lock() else {
            return json!({ "windows": [], "tabs": [] });
        };
        let tabs = snapshot
            .tabs
            .iter()
            .map(|tab| {
                let active = snapshot
                    .displays
                    .iter()
                    .any(|display| display.active_tab_id.as_deref() == Some(tab.id.as_str()));
                json!({
                    "id": tab.id,
                    "type": if tab.tab_type == "workspace" { "workspace" } else { "role" },
                    "sourceId": tab.source_id,
                    "name": tab.name,
                    "displayId": tab.display_id,
                    "roleIds": tab.role_ids,
                    "hidden": tab.hidden,
                    "active": active,
                    "audible": false,
                    "audioMuted": false
                })
            })
            .collect::<Vec<_>>();
        let windows = snapshot
            .displays
            .iter()
            .filter_map(|display| {
                let tab_id = display.active_tab_id.as_ref()?;
                let tab = state.tabs.get(tab_id)?;
                Some(json!({
                    "id": runtime_label("game-tab", tab_id),
                    "displayId": display.display_id,
                    "bounds": tab.target.work_area,
                    "visible": tab.window.is_visible().unwrap_or(false),
                    "focused": tab.window.is_focused().unwrap_or(false),
                    "activeTabId": tab_id,
                    "tabCount": display.tab_ids.len()
                }))
            })
            .collect::<Vec<_>>();
        json!({ "windows": windows, "tabs": tabs })
    }

    fn apply(&self, effect: CoreEffectRequest) -> RuntimeResult<Option<String>> {
        match effect.action {
            CoreEffectAction::EmbeddedCreateTab { tab } => self.create_tab(*tab).map(|()| None),
            CoreEffectAction::EmbeddedConfigureRoleSessions { role_ids } => {
                self.require_roles(&role_ids)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedLoadRoles { roles } => {
                self.load_roles(roles)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedInstallOverlays { role_ids } => {
                self.install_overlays(&role_ids)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedFocusRole {
                role_id,
                zoom_factor,
            } => {
                self.focus_role(&role_id, zoom_factor)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedDestroyRole { role_id } => {
                self.destroy_role(&role_id)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedDestroyTab {
                tab_id,
                next_active_tab_id,
            } => {
                self.destroy_tab(&tab_id)?;
                if let Some(next_tab_id) = next_active_tab_id {
                    self.show_tab(&next_tab_id, true)?;
                }
                Ok(None)
            }
            CoreEffectAction::EmbeddedApplyRuntime {
                snapshot,
                target,
                reveal_display_ids,
                focus_window_display_ids,
                focus_tab_id,
            } => {
                self.apply_runtime(
                    snapshot,
                    target,
                    &reveal_display_ids,
                    &focus_window_display_ids,
                    focus_tab_id.as_deref(),
                )?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedFallbackTabToElectron { .. } => Err(RuntimeError::new(
                "TAURI_ELECTRON_HELPER_UNAVAILABLE",
                "Electron fallback requires the bundled runtime helper.",
            )),
            CoreEffectAction::SetAudioMuted { muted } => {
                self.set_role_audio_muted(&effect.target.handle_id, muted)?;
                Ok(None)
            }
            _ => Err(RuntimeError::new(
                "TAURI_EFFECT_UNSUPPORTED",
                "This runtime effect is not implemented by the Tauri system executor.",
            )),
        }
    }

    fn create_tab(&self, tab: EmbeddedTabEffectRecord) -> RuntimeResult<()> {
        if tab
            .roles
            .iter()
            .any(|role| !is_current_system_engine(role.resolved_engine))
        {
            return Err(RuntimeError::new(
                "TAURI_ELECTRON_HELPER_UNAVAILABLE",
                "This tab resolved to Electron and requires the bundled runtime helper.",
            ));
        }
        let mut state = self.state()?;
        if state.tabs.contains_key(&tab.tab_id) {
            return Err(RuntimeError::new(
                "TAURI_RUNTIME_TAB_DUPLICATE",
                "The System WebView tab already exists.",
            ));
        }
        let window_label = runtime_label("game-tab", &tab.tab_id);
        if let Some(existing) = self.app.get_window(&window_label) {
            let _ = existing.close();
        }
        let target = tab.target.clone();
        let window = WindowBuilder::new(&self.app, window_label)
            .title(&tab.name)
            .position(target.work_area.x as f64, target.work_area.y as f64)
            .inner_size(
                target.work_area.width.max(1) as f64,
                target.work_area.height.max(1) as f64,
            )
            .visible(false)
            .build()
            .map_err(RuntimeError::tauri)?;
        let mut surfaces = HashMap::new();
        let mut role_ids = Vec::with_capacity(tab.roles.len());
        for role in &tab.roles {
            let role_id = role.role.id.clone();
            let navigation = Arc::new(NavigationTracker::default());
            let callback_navigation = Arc::clone(&navigation);
            let role_label = runtime_label("game-role", &role_id);
            let paths = role_session_paths(&self.user_data_dir, &role_id)?;
            fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
            let builder =
                WebviewBuilder::new(
                    role_label,
                    WebviewUrl::External("about:blank".parse().map_err(|_| {
                        RuntimeError::new("TAURI_URL_INVALID", "Invalid blank URL.")
                    })?),
                )
                .data_directory(paths.webview2)
                .data_store_identifier(paths.webkit_identifier)
                .initialization_script_for_all_frames(SYSTEM_RUNTIME_INIT_SCRIPT)
                .zoom_hotkeys_enabled(false)
                .on_navigation(|url| matches!(url.scheme(), "about" | "http" | "https"))
                .on_page_load(move |_webview, payload| {
                    callback_navigation.page_event(payload.event());
                });
            let bounds = role_bounds(&target, &role.rect);
            let webview = window
                .add_child(
                    builder,
                    LogicalPosition::new(bounds.x, bounds.y),
                    LogicalSize::new(bounds.width, bounds.height),
                )
                .map_err(|error| {
                    let _ = window.close();
                    RuntimeError::tauri(error)
                })?;
            webview
                .set_zoom(role.zoom_factor)
                .map_err(RuntimeError::tauri)?;
            role_ids.push(role_id.clone());
            surfaces.insert(
                role_id,
                RoleSurface {
                    navigation,
                    webview,
                },
            );
        }
        let tab_id = tab.tab_id;
        for role_id in role_ids {
            state.role_tabs.insert(role_id, tab_id.clone());
        }
        state.tabs.insert(
            tab_id,
            RuntimeTab {
                display_id: target.display_id,
                roles: surfaces,
                target,
                window,
            },
        );
        Ok(())
    }

    fn load_roles(&self, roles: Vec<EmbeddedRoleLoadEffectRecord>) -> RuntimeResult<()> {
        for role in roles {
            if !is_current_system_engine(role.resolved_engine) {
                return Err(RuntimeError::new(
                    "TAURI_ELECTRON_HELPER_UNAVAILABLE",
                    "The role resolved to Electron and requires the bundled runtime helper.",
                ));
            }
            let (surface, navigation) = {
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
                (surface.webview.clone(), Arc::clone(&surface.navigation))
            };
            let url = Url::parse(&role.url)
                .map_err(|_| RuntimeError::new("TAURI_URL_INVALID", "Role URL is invalid."))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(RuntimeError::new(
                    "TAURI_URL_INVALID",
                    "Role URL must use HTTP or HTTPS.",
                ));
            }
            navigation.reset();
            surface.navigate(url).map_err(RuntimeError::tauri)?;
            surface
                .set_zoom(role.zoom_factor)
                .map_err(RuntimeError::tauri)?;
            navigation
                .wait()
                .map_err(|message| RuntimeError::new("TAURI_NAVIGATION_FAILED", message))?;
        }
        Ok(())
    }

    fn install_overlays(&self, role_ids: &[String]) -> RuntimeResult<()> {
        for role_id in role_ids {
            let webview = self.role_webview(role_id)?;
            webview
                .eval("document.documentElement.dataset.rionSystemOverlayBridge = 'ready';")
                .map_err(RuntimeError::tauri)?;
        }
        Ok(())
    }

    fn focus_role(&self, role_id: &str, zoom_factor: Option<f64>) -> RuntimeResult<()> {
        let (window, webview) = {
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
            (tab.window.clone(), role.webview.clone())
        };
        if let Some(zoom_factor) = zoom_factor {
            webview.set_zoom(zoom_factor).map_err(RuntimeError::tauri)?;
        }
        window.show().map_err(RuntimeError::tauri)?;
        window.set_focus().map_err(RuntimeError::tauri)?;
        webview.set_focus().map_err(RuntimeError::tauri)
    }

    fn apply_runtime(
        &self,
        snapshot: BrowserRuntimeSnapshot,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_display_ids: &[i64],
        focus_window_display_ids: &[i64],
        focus_tab_id: Option<&str>,
    ) -> RuntimeResult<()> {
        let mut state = self.state()?;
        let active_tabs = snapshot
            .displays
            .iter()
            .filter_map(|display| {
                display
                    .active_tab_id
                    .as_ref()
                    .map(|tab_id| (display.display_id, tab_id.as_str()))
            })
            .collect::<HashMap<_, _>>();
        for (tab_id, runtime_tab) in &mut state.tabs {
            let snapshot_tab = snapshot.tabs.iter().find(|tab| &tab.id == tab_id);
            if let (Some(target), Some(snapshot_tab)) = (&target, snapshot_tab)
                && snapshot_tab.display_id == target.display_id
            {
                runtime_tab.display_id = target.display_id;
                runtime_tab.target = target.clone();
                runtime_tab
                    .window
                    .set_position(LogicalPosition::new(
                        target.work_area.x as f64,
                        target.work_area.y as f64,
                    ))
                    .map_err(RuntimeError::tauri)?;
                runtime_tab
                    .window
                    .set_size(LogicalSize::new(
                        target.work_area.width.max(1) as f64,
                        target.work_area.height.max(1) as f64,
                    ))
                    .map_err(RuntimeError::tauri)?;
            }
            let visible = snapshot_tab.is_some_and(|tab| {
                !tab.hidden
                    && active_tabs.get(&tab.display_id).copied() == Some(tab.id.as_str())
                    && (reveal_display_ids.is_empty()
                        || reveal_display_ids.contains(&tab.display_id))
            });
            if visible {
                runtime_tab.window.show().map_err(RuntimeError::tauri)?;
            } else {
                runtime_tab.window.hide().map_err(RuntimeError::tauri)?;
            }
            let should_focus = focus_tab_id == Some(tab_id.as_str())
                || (visible && focus_window_display_ids.contains(&runtime_tab.display_id));
            if should_focus {
                runtime_tab
                    .window
                    .set_focus()
                    .map_err(RuntimeError::tauri)?;
            }
        }
        Ok(())
    }

    fn destroy_role(&self, role_id: &str) -> RuntimeResult<()> {
        let mut state = self.state()?;
        let tab_id = state.role_tabs.remove(role_id).ok_or_else(|| {
            RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime role was not found.",
            )
        })?;
        let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| {
            RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
        })?;
        let role = tab.roles.remove(role_id).ok_or_else(|| {
            RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime role was not found.",
            )
        })?;
        role.webview.close().map_err(RuntimeError::tauri)
    }

    fn destroy_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let mut state = self.state()?;
        let tab = state.tabs.remove(tab_id).ok_or_else(|| {
            RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
        })?;
        for role_id in tab.roles.keys() {
            state.role_tabs.remove(role_id);
        }
        drop(state);
        tab.window.close().map_err(RuntimeError::tauri)
    }

    fn show_tab(&self, tab_id: &str, focus: bool) -> RuntimeResult<()> {
        let state = self.state()?;
        let tab = state.tabs.get(tab_id).ok_or_else(|| {
            RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
        })?;
        tab.window.show().map_err(RuntimeError::tauri)?;
        if focus {
            tab.window.set_focus().map_err(RuntimeError::tauri)?;
        }
        Ok(())
    }

    fn set_role_audio_muted(&self, role_id: &str, muted: bool) -> RuntimeResult<()> {
        let webview = self.role_webview(role_id)?;
        set_audio_muted(&webview, muted)
    }

    fn role_webview(&self, role_id: &str) -> RuntimeResult<Webview> {
        let state = self.state()?;
        let tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
            RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime role was not found.",
            )
        })?;
        state.tabs[tab_id]
            .roles
            .get(role_id)
            .map(|role| role.webview.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })
    }

    fn require_roles(&self, role_ids: &[String]) -> RuntimeResult<()> {
        let state = self.state()?;
        if role_ids
            .iter()
            .all(|role_id| state.role_tabs.contains_key(role_id))
        {
            Ok(())
        } else {
            Err(RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "A runtime role was not found.",
            ))
        }
    }

    fn state(&self) -> RuntimeResult<std::sync::MutexGuard<'_, RuntimeState>> {
        self.state.lock().map_err(|_| {
            RuntimeError::new(
                "TAURI_RUNTIME_STATE_FAILED",
                "System runtime state lock poisoned.",
            )
        })
    }
}

impl Drop for SystemRuntimeExecutor {
    fn drop(&mut self) {
        self.close_all();
    }
}

struct SessionPaths {
    webkit_identifier: [u8; 16],
    webview2: PathBuf,
}

fn role_session_paths(user_data_dir: &Path, role_id: &str) -> RuntimeResult<SessionPaths> {
    if role_id.is_empty()
        || role_id.len() > 128
        || !role_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(RuntimeError::new(
            "TAURI_RUNTIME_ROLE_INVALID",
            "Runtime role ID is invalid.",
        ));
    }
    let digest = Sha256::digest(format!("rion-studio:wkwebsite-data-store:{role_id}"));
    let mut identifier = [0_u8; 16];
    identifier.copy_from_slice(&digest[..16]);
    identifier[6] = (identifier[6] & 0x0f) | 0x80;
    identifier[8] = (identifier[8] & 0x3f) | 0x80;
    Ok(SessionPaths {
        webkit_identifier: identifier,
        webview2: user_data_dir
            .join("roles")
            .join(role_id)
            .join("browser")
            .join("webview2"),
    })
}

struct RoleBounds {
    height: f64,
    width: f64,
    x: f64,
    y: f64,
}

fn role_bounds(
    target: &EmbeddedLaunchTargetRecord,
    rect: &rion_core::StateNormalizedRectRecord,
) -> RoleBounds {
    let width = target.work_area.width.max(1) as f64;
    let height = target.work_area.height.max(1) as f64;
    RoleBounds {
        x: (rect.x * width).round().max(0.0),
        y: (rect.y * height).round().max(0.0),
        width: (rect.width * width).round().max(1.0),
        height: (rect.height * height).round().max(1.0),
    }
}

fn runtime_label(prefix: &str, id: &str) -> String {
    let digest = Sha256::digest(id.as_bytes());
    let encoded = format!("{digest:x}");
    format!("{prefix}-{}", &encoded[..24])
}

fn is_current_system_engine(engine: ResolvedBrowserEngine) -> bool {
    if cfg!(target_os = "macos") {
        engine == ResolvedBrowserEngine::Wkwebview
    } else {
        engine == ResolvedBrowserEngine::Webview2
    }
}

fn supported_if(available: bool) -> EngineCapabilityStatus {
    if available {
        EngineCapabilityStatus::Supported
    } else {
        EngineCapabilityStatus::Disabled
    }
}

#[cfg(target_os = "macos")]
fn set_audio_muted(webview: &Webview, muted: bool) -> RuntimeResult<()> {
    use std::{ffi::c_void, os::raw::c_char};

    unsafe extern "C" {
        fn objc_msgSend();
        fn sel_registerName(name: *const c_char) -> *mut c_void;
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let selector = b"_setMuted:\0";
            let selector = sel_registerName(selector.as_ptr().cast());
            let send: unsafe extern "C" fn(*mut c_void, *mut c_void, bool) =
                std::mem::transmute(objc_msgSend as *const ());
            send(platform_webview.inner(), selector, muted);
            let _ = sender.send(());
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| RuntimeError::new("TAURI_AUDIO_MUTE_FAILED", "Audio mute timed out."))
}

#[cfg(windows)]
fn set_audio_muted(webview: &Webview, muted: bool) -> RuntimeResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows::core::Interface;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_8>())
                .and_then(|core| core.SetIsMuted(muted.into()))
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| RuntimeError::new("TAURI_AUDIO_MUTE_FAILED", "Audio mute timed out."))?
        .map_err(|message| RuntimeError::new("TAURI_AUDIO_MUTE_FAILED", message))
}

type RuntimeResult<T> = Result<T, RuntimeError>;

#[derive(Debug)]
struct RuntimeError {
    code: &'static str,
    message: String,
}

impl RuntimeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(error: std::io::Error) -> Self {
        Self::new("TAURI_RUNTIME_IO_FAILED", error.to_string())
    }

    fn tauri(error: impl std::fmt::Display) -> Self {
        Self::new("TAURI_RUNTIME_FAILED", error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn role_session_identity_matches_the_core_uuid_v8_algorithm() {
        let paths = role_session_paths(Path::new("/tmp/rion"), "role-1").unwrap();
        assert_eq!(
            Uuid::from_bytes(paths.webkit_identifier).to_string(),
            "32792c51-c7ee-8dce-afb2-a97ea4a6bc46"
        );
    }

    #[test]
    fn role_bounds_are_relative_to_the_host_work_area() {
        let target = EmbeddedLaunchTargetRecord {
            display_id: 7,
            work_area: rion_core::StatePixelBoundsRecord {
                x: 100,
                y: 50,
                width: 1_200,
                height: 800,
            },
        };
        let bounds = role_bounds(
            &target,
            &rion_core::StateNormalizedRectRecord {
                x: 0.5,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
        );
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (600.0, 0.0, 600.0, 800.0)
        );
    }
}
