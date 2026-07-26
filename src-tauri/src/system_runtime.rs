use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use rion_core::{
    AppCore, BrowserAction, BrowserActionRequest, BrowserRuntimeSnapshot,
    CompatibilityCheckPlanRecord, CoreCommand, CoreEffectAction, CoreEffectRequest,
    CoreEffectResult, EmbeddedKeyEffectRecord, EmbeddedKeyTransitionRecord,
    EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord, EmbeddedRoleViewEffectRecord,
    EmbeddedTabEffectRecord, EngineCapabilitySnapshotRecord, EngineCapabilityStatus,
    GameBrowserSettingsRecord, LayoutBounds, LayoutDividerInput, LayoutRect, LayoutRoleInput,
    ResolvedBrowserEngine, RuntimeRestoreSessionRecord, RuntimeRestoreTabRecord,
    RuntimeRestoreWindowRecord, StateGameRecord, StateNormalizedRectRecord, StateRoleRecord,
    StateWorkspaceDisplayTargetRecord, SystemWebViewRuntimeRegistrationRecord,
    WorkspaceAppearanceSettingsRecord, WorkspaceDividerDescriptor, WorkspaceDividerResizeInput,
    WorkspaceDividerResizeOutput, WorkspaceLayoutInput, WorkspaceLayoutOutput,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl,
    WebviewWindowBuilder, Window,
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    window::WindowBuilder,
};

const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(40);
const DIVIDER_HIT_TARGET: f64 = 10.0;
#[cfg(windows)]
const WINDOWS_TAB_STRIP_HEIGHT: f64 = 44.0;
const PLATFORM_CALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
const SURFACE_RECOVERY_LIMIT: u8 = 2;
const SURFACE_RECOVERY_WINDOW: Duration = Duration::from_secs(60);
#[cfg(any(windows, target_os = "macos"))]
const TRUSTED_INPUT_EVENT_INTERVAL: Duration = Duration::from_millis(25);
static POPUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static DISPLAY_HOST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[cfg(any(windows, target_os = "macos"))]
const DOWNLOAD_ATTESTATION_BODY: &[u8] = b"Rion Studio System WebView download attestation\n";
#[cfg(any(windows, target_os = "macos"))]
const UPLOAD_ATTESTATION_BODY: &[u8] = b"Rion Studio System WebView upload attestation\n";
const MACRO_OVERLAY_RUNTIME_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/macroOverlayRuntime.js");
const MACRO_OVERLAY_CSS: &str = include_str!("../../src/shared/browser-overlay/macroOverlay.css");
const MACRO_OVERLAY_SHORTCUT_GUARD_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/macroOverlayShortcutGuard.js");
const MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__";
const MACRO_OVERLAY_CSS_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_CSS__";
const SYSTEM_RUNTIME_INIT_SCRIPT: &str = r#"
Object.defineProperty(window, "__rionSystemWebView", {
  configurable: false,
  enumerable: false,
  value: Object.freeze({ version: 1 })
});
"#;
const RUNTIME_TAB_SHORTCUT_SCRIPT: &str = r#"
addEventListener("keydown", (event) => {
  if (event.isComposing || event.key !== "Tab" || !event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const direction = event.shiftKey ? "previous" : "next";
  location.href = `rion-runtime-shortcut://tabs/${direction}?nonce=${Date.now()}-${Math.random()}`;
}, true);
"#;
const RUNTIME_AUDIO_OBSERVER_SCRIPT: &str = r#"
(() => {
  if (globalThis.__rionSystemAudioObserverInstalled || globalThis.top !== globalThis) return;
  globalThis.__rionSystemAudioObserverInstalled = true;
  let previous;
  const publish = () => {
    const media = [...document.querySelectorAll("audio,video")];
    const audible = media.some((item) => !item.paused && !item.muted && item.volume > 0);
    if (audible === previous) return;
    previous = audible;
    const internals = globalThis.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return;
    void internals.invoke("rion_runtime_audio_state", { audible }).catch(() => undefined);
  };
  for (const name of ["play", "pause", "volumechange", "ended", "emptied"]) {
    document.addEventListener(name, publish, true);
  }
  document.addEventListener("DOMContentLoaded", publish, { once: true });
})();
"#;
const WORKSPACE_RESIZE_INDICATOR_SCRIPT: &str = r#"
(() => {
  if (globalThis.__rionStudioWorkspaceResizeIndicator) return;
  const id = "rion-studio-workspace-resize-indicator";
  globalThis.__rionStudioWorkspaceResizeIndicator = (payload) => {
    let element = document.getElementById(id);
    if (payload?.type === "hide") { element?.remove(); return; }
    if (!element) {
      element = document.createElement("div"); element.id = id;
      Object.assign(element.style, { background:"rgba(15,23,42,.88)", border:"1px solid rgba(255,255,255,.2)", borderRadius:"8px", color:"white", font:"600 13px system-ui,sans-serif", left:"50%", padding:"6px 10px", pointerEvents:"none", position:"fixed", top:"16px", transform:"translateX(-50%)", zIndex:"2147483647" });
      (document.body || document.documentElement).append(element);
    }
    element.textContent = String(payload?.label || "");
  };
})();
"#;
#[cfg(any(windows, target_os = "macos"))]
const TRUSTED_INPUT_ATTESTATION_SOURCE: &str = r#"(() => {
  const state = {
    allTrusted: true,
    backgroundOnly: true,
    clickCount: 0,
    clickTargets: new Set(),
    codes: new Set(),
    held: new Set(),
    keyDown: 0,
    keyUp: 0,
    modifierObserved: false,
    mouseClientX: null,
    mouseClientY: null,
    mouseDown: 0,
    mouseUp: 0,
    repeatCount: 0
  };
  const observe = (event) => {
    state.allTrusted = state.allTrusted && event.isTrusted === true;
    state.backgroundOnly = state.backgroundOnly && document.hasFocus() === false;
  };
  addEventListener("keydown", (event) => {
    observe(event);
    state.keyDown += 1;
    state.codes.add(event.code);
    state.held.add(event.code);
    if (event.repeat) state.repeatCount += 1;
    if (event.code === "KeyA" && event.shiftKey) state.modifierObserved = true;
  }, true);
  addEventListener("keyup", (event) => {
    observe(event);
    state.keyUp += 1;
    state.codes.add(event.code);
    state.held.delete(event.code);
  }, true);
  addEventListener("mousedown", (event) => {
    observe(event);
    state.mouseClientX = event.clientX;
    state.mouseClientY = event.clientY;
    state.mouseDown += 1;
  }, true);
  addEventListener("mouseup", (event) => {
    observe(event);
    state.mouseUp += 1;
  }, true);
  addEventListener("click", (event) => {
    observe(event);
    state.clickCount += 1;
    if (event.target instanceof Element) state.clickTargets.add(event.target.id || event.target.tagName);
  }, true);
  state.reset = () => {
    state.allTrusted = true;
    state.backgroundOnly = true;
    state.clickCount = 0;
    state.clickTargets.clear();
    state.codes.clear();
    state.held.clear();
    state.keyDown = 0;
    state.keyUp = 0;
    state.modifierObserved = false;
    state.mouseClientX = null;
    state.mouseClientY = null;
    state.mouseDown = 0;
    state.mouseUp = 0;
    state.repeatCount = 0;
    return true;
  };
  state.snapshot = () => ({
    allTrusted: state.allTrusted,
    backgroundOnly: state.backgroundOnly,
    clickCount: state.clickCount,
    clickTargets: [...state.clickTargets].sort(),
    codes: [...state.codes].sort(),
    documentFocused: document.hasFocus(),
    heldCount: state.held.size,
    keyDown: state.keyDown,
    keyUp: state.keyUp,
    modifierObserved: state.modifierObserved,
    mouseClientX: state.mouseClientX,
    mouseClientY: state.mouseClientY,
    mouseDown: state.mouseDown,
    mouseUp: state.mouseUp,
    repeatCount: state.repeatCount
  });
  Object.defineProperty(globalThis, "__rionInputAttestation", {
    configurable: false,
    value: state
  });
})()"#;
const TAURI_MACRO_OVERLAY_BRIDGE_SOURCE: &str = r#"(() => {
  const version = "rion-tauri-overlay-1";
  if (globalThis.__rionStudioNativeOverlayBridge?.version === version) return;
  const invoke = (payload) => {
    const internals = globalThis.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("Rion Studio overlay IPC is unavailable."));
    }
    return internals.invoke("rion_overlay_request", { payload });
  };
  globalThis.__rionStudioNativeOverlayBridge = Object.freeze({ version });
  Object.defineProperty(globalThis, "rionStudioMacroOverlay", {
    configurable: true,
    value: invoke
  });
})();"#;

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

    fn page_event(&self, event: PageLoadEvent, url: &Url) {
        if !matches!(url.scheme(), "http" | "https") {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            match event {
                PageLoadEvent::Started => state.started = true,
                // WKWebView can omit the Started callback when several child
                // views navigate together. A completed HTTP(S) page is still
                // authoritative; initial about:blank and bounded internal
                // command schemes were filtered above.
                PageLoadEvent::Finished => state.finished = true,
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
    current_url: Option<Url>,
    navigation: Arc<NavigationTracker>,
    rect: rion_core::StateNormalizedRectRecord,
    webview: Webview,
    zoom_factor: f64,
}

struct RuntimeTab {
    active_divider_resize: Option<ActiveDividerResize>,
    audio_muted: bool,
    dividers: Vec<RuntimeDivider>,
    display_id: i64,
    roles: HashMap<String, RoleSurface>,
    workspace_appearance: WorkspaceAppearanceSettingsRecord,
    workspace_template: Option<String>,
}

struct RuntimeDisplayHost {
    target: EmbeddedLaunchTargetRecord,
    window: Window,
    #[cfg(windows)]
    tab_strip: Webview,
    #[cfg(windows)]
    toolbar_revealed: bool,
    #[cfg(target_os = "macos")]
    tabs_controller: crate::runtime_tabs_macos::MacRuntimeTabsController,
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeTabHostPlan {
    active: bool,
    display_id: i64,
    focus: bool,
    moved: bool,
    tab_id: String,
}

fn resolve_runtime_tab_host_plan(
    snapshot: &BrowserRuntimeSnapshot,
    live_displays: &HashMap<String, i64>,
    focus_window_display_ids: &[i64],
    focus_tab_id: Option<&str>,
) -> Vec<RuntimeTabHostPlan> {
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
    snapshot
        .tabs
        .iter()
        .filter_map(|tab| {
            let live_display_id = *live_displays.get(&tab.id)?;
            let active =
                !tab.hidden && active_tabs.get(&tab.display_id).copied() == Some(tab.id.as_str());
            Some(RuntimeTabHostPlan {
                active,
                display_id: tab.display_id,
                focus: focus_tab_id == Some(tab.id.as_str())
                    || (active && focus_window_display_ids.contains(&tab.display_id)),
                moved: live_display_id != tab.display_id,
                tab_id: tab.id.clone(),
            })
        })
        .collect()
}

fn runtime_tab_is_audible(state: &RuntimeState, tab: &RuntimeTab) -> bool {
    tab.roles.values().any(|surface| {
        state
            .audible_webviews
            .get(surface.webview.label())
            .copied()
            .unwrap_or(false)
    }) || state.popup_roles.iter().any(|(label, role_id)| {
        tab.roles.contains_key(role_id)
            && state.audible_webviews.get(label).copied().unwrap_or(false)
    })
}

struct RuntimeDivider {
    descriptor: WorkspaceDividerDescriptor,
    index: u32,
    webview: Webview,
}

struct ActiveDividerResize {
    divider_index: u32,
    role_ids: Vec<String>,
    snapped_position: f64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividerPointerPayload {
    phase: String,
    screen_position: Option<f64>,
}

struct CompatibilitySurface {
    data_directory: PathBuf,
    navigation: Arc<NavigationTracker>,
    webview: Webview,
    window: Window,
}

struct RecoveryBudget {
    attempts: u8,
    window_started: Instant,
}

impl RecoveryBudget {
    fn claim(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.window_started) > SURFACE_RECOVERY_WINDOW {
            self.attempts = 0;
            self.window_started = now;
        }
        if self.attempts >= SURFACE_RECOVERY_LIMIT {
            return false;
        }
        self.attempts += 1;
        true
    }
}

#[derive(Default)]
struct RuntimeState {
    active_window_resize_workers: HashSet<String>,
    allow_window_close_labels: HashSet<String>,
    audible_webviews: HashMap<String, bool>,
    auto_restore_attempted: bool,
    compatibility: HashMap<String, CompatibilitySurface>,
    dormant_windows: Vec<RuntimeRestoreWindowRecord>,
    pending_macro_page_request: Option<Value>,
    pending_window_resizes: HashMap<String, (u32, u32)>,
    pending_window_close_labels: HashSet<String>,
    popup_roles: HashMap<String, String>,
    recovery_required: bool,
    recovery_budgets: HashMap<String, RecoveryBudget>,
    recovery_generations: HashMap<String, u64>,
    recovering_roles: HashSet<String>,
    role_tabs: HashMap<String, String>,
    display_hosts: HashMap<i64, RuntimeDisplayHost>,
    tabs: HashMap<String, RuntimeTab>,
}

struct RuntimeWebViewConfiguration {
    #[cfg_attr(not(windows), allow(dead_code))]
    additional_browser_arguments: String,
    document_start_script: String,
    #[cfg(any(windows, target_os = "macos"))]
    download_attestation: Option<Arc<DownloadAttestationTracker>>,
    overlay_document_start_script: String,
}

#[cfg(any(windows, target_os = "macos"))]
#[derive(Default)]
struct DownloadAttestationState {
    destination: Option<PathBuf>,
    finished: bool,
    requested: bool,
    success: bool,
    url: Option<String>,
}

#[cfg(any(windows, target_os = "macos"))]
struct DownloadAttestationTracker {
    changed: Condvar,
    directory: PathBuf,
    state: Mutex<DownloadAttestationState>,
}

#[cfg(any(windows, target_os = "macos"))]
impl DownloadAttestationTracker {
    fn from_environment() -> Option<Arc<Self>> {
        let output = std::env::var_os("RION_STUDIO_INPUT_ATTESTATION_OUTPUT")?;
        let directory = PathBuf::from(output).parent()?.join("downloads");
        fs::create_dir_all(&directory).ok()?;
        Some(Arc::new(Self {
            changed: Condvar::new(),
            directory,
            state: Mutex::new(DownloadAttestationState::default()),
        }))
    }

    fn reset(&self) -> RuntimeResult<()> {
        let mut state = self.state.lock().map_err(|_| {
            input_attestation_error("The download attestation state lock was poisoned.")
        })?;
        *state = DownloadAttestationState::default();
        Ok(())
    }

    fn requested(&self, url: &Url, destination: &mut PathBuf) {
        *destination = self.directory.join("rion-system-download-attestation.bin");
        if let Ok(mut state) = self.state.lock() {
            state.destination = Some(destination.clone());
            state.requested = true;
            state.url = Some(url.to_string());
            self.changed.notify_all();
        }
    }

    fn finished(&self, success: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.finished = true;
            state.success = success;
            self.changed.notify_all();
        }
    }

    fn wait(&self) -> RuntimeResult<PathBuf> {
        let deadline = Instant::now() + NAVIGATION_TIMEOUT;
        let mut state = self.state.lock().map_err(|_| {
            input_attestation_error("The download attestation state lock was poisoned.")
        })?;
        while !state.finished {
            let now = Instant::now();
            if now >= deadline {
                return Err(input_attestation_error(
                    "The System WebView download attestation timed out.",
                ));
            }
            let (next, timeout) = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| {
                    input_attestation_error("The download attestation state lock was poisoned.")
                })?;
            state = next;
            if timeout.timed_out() && !state.finished {
                return Err(input_attestation_error(
                    "The System WebView download attestation timed out.",
                ));
            }
        }
        if !state.requested || !state.success {
            return Err(input_attestation_error(format!(
                "The System WebView download did not complete successfully: requested={}, success={}, url={:?}.",
                state.requested, state.success, state.url
            )));
        }
        state.destination.clone().ok_or_else(|| {
            input_attestation_error("The System WebView download had no destination.")
        })
    }
}

pub struct SystemRuntimeExecutor {
    app: AppHandle,
    configuration: RuntimeWebViewConfiguration,
    core: Arc<AppCore>,
    language: Mutex<String>,
    state: Mutex<RuntimeState>,
    user_data_dir: PathBuf,
}

impl SystemRuntimeExecutor {
    pub fn new(app: AppHandle, user_data_dir: PathBuf, core: Arc<AppCore>) -> Result<Self, String> {
        let settings = core
            .invoke(CoreCommand::GameBrowserSettingsGet)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<GameBrowserSettingsRecord>(value)
                    .map_err(|error| error.to_string())
            })?;
        let platform = if cfg!(target_os = "macos") {
            rion_platform::Platform::Macos
        } else {
            rion_platform::Platform::Windows
        };
        let plan = rion_core::read_bootstrap_plan(
            &user_data_dir,
            platform,
            "",
            "msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        );
        let additional_browser_arguments = plan
            .switches
            .iter()
            .map(|item| match &item.value {
                Some(value) => format!("--{}={value}", item.name),
                None => format!("--{}", item.name),
            })
            .collect::<Vec<_>>()
            .join(" ");
        let document_start_script = [
            SYSTEM_RUNTIME_INIT_SCRIPT.to_owned(),
            RUNTIME_TAB_SHORTCUT_SCRIPT.to_owned(),
            RUNTIME_AUDIO_OBSERVER_SCRIPT.to_owned(),
            WORKSPACE_RESIZE_INDICATOR_SCRIPT.to_owned(),
            native_font_document_start_script(&settings),
        ]
        .into_iter()
        .filter(|source| !source.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        let overlay_document_start_script = macro_overlay_document_start_script()?;
        let stored_restore_session = core
            .invoke(CoreCommand::RuntimeRestoreSessionGet)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<RuntimeRestoreSessionRecord>(value)
                    .map_err(|error| error.to_string())
            })?;
        let recovery_required =
            !stored_restore_session.clean_exit && !stored_restore_session.windows.is_empty();
        let dormant_windows = stored_restore_session.windows.clone();
        let mut unclean_session = stored_restore_session;
        unclean_session.clean_exit = false;
        unclean_session.updated_at = chrono::Utc::now().to_rfc3339();
        core.invoke(CoreCommand::RuntimeRestoreSessionReplace {
            session: unclean_session,
        })
        .map_err(|error| error.to_string())?;

        Ok(Self {
            app,
            configuration: RuntimeWebViewConfiguration {
                additional_browser_arguments,
                document_start_script,
                #[cfg(any(windows, target_os = "macos"))]
                download_attestation: DownloadAttestationTracker::from_environment(),
                overlay_document_start_script,
            },
            core,
            language: Mutex::new("en".to_owned()),
            state: Mutex::new(RuntimeState {
                dormant_windows,
                recovery_required,
                ..RuntimeState::default()
            }),
            user_data_dir,
        })
    }

    pub fn registration(&self) -> SystemWebViewRuntimeRegistrationRecord {
        let platform = if cfg!(target_os = "macos") {
            rion_platform::Platform::Macos
        } else {
            rion_platform::Platform::Windows
        };
        let probe = rion_platform::probe_system_webview(platform);
        let available = probe.available && probe.audio_mute_available;
        let trusted_input_attested = trusted_input_attested();
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
            adapter_version: format!(
                "tauri-wry-{}{}",
                env!("CARGO_PKG_VERSION"),
                if trusted_input_attested {
                    "+trusted-input-attested"
                } else {
                    ""
                }
            ),
            available,
            capability_snapshot: EngineCapabilitySnapshotRecord {
                navigation: supported_if(available),
                persistent_session: supported_if(available),
                trusted_input: trusted_input_status(available, trusted_input_attested),
                background_input: trusted_input_status(available, trusted_input_attested),
                frame_evaluation: if available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                popup: degraded_if(available),
                audio_mute: supported_if(available),
                custom_fonts: degraded_if(available),
                graphics_tuning: if available && cfg!(target_os = "windows") {
                    EngineCapabilityStatus::Supported
                } else if available {
                    EngineCapabilityStatus::Unsupported
                } else {
                    EngineCapabilityStatus::Disabled
                },
                downloads: degraded_if(available),
                file_upload: supported_if(available),
                permissions: if available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                dialogs: supported_if(available),
                certificate_handling: supported_if(available),
            },
            failure_reason: (!available).then_some(if cfg!(target_os = "macos") {
                rion_core::SystemWebViewIssueReason::WebkitSpiUnavailable
            } else {
                rion_core::SystemWebViewIssueReason::RuntimeCreationFailed
            }),
        }
    }

    pub fn set_language(&self, language: &str) {
        if matches!(language, "en" | "zh-TW" | "zh-CN" | "ja") {
            if let Ok(mut current) = self.language.lock() {
                *current = language.to_owned();
            }
            self.publish_projection();
        }
    }

    pub fn window_for_tab(&self, tab_id: &str) -> Option<Window> {
        self.state.lock().ok().and_then(|state| {
            let display_id = state.tabs.get(tab_id)?.display_id;
            state
                .display_hosts
                .get(&display_id)
                .map(|host| host.window.clone())
        })
    }

    pub fn window_for_display(&self, display_id: i64) -> Option<Window> {
        self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(&display_id)
                .map(|host| host.window.clone())
        })
    }

    #[cfg(windows)]
    pub fn tab_strip_display_for_webview(&self, webview_label: &str) -> Option<i64> {
        self.state.lock().ok().and_then(|state| {
            state.display_hosts.values().find_map(|host| {
                (host.tab_strip.label() == webview_label).then_some(host.target.display_id)
            })
        })
    }

    #[cfg(not(windows))]
    pub fn tab_strip_display_for_webview(&self, _webview_label: &str) -> Option<i64> {
        None
    }

    pub fn set_tab_audio_muted(&self, tab_id: &str, muted: bool) -> Result<(), String> {
        let role_id = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                    .map_err(|error| error.to_string())
            })?
            .tabs
            .into_iter()
            .find(|tab| tab.id == tab_id)
            .and_then(|tab| tab.role_ids.first().cloned())
            .ok_or_else(|| "runtime tab has no role surface".to_owned())?;
        self.set_role_audio_muted(&role_id, muted)
            .map_err(|error| error.message)?;
        self.publish_projection();
        Ok(())
    }

    #[cfg(windows)]
    pub fn set_windows_toolbar_revealed(
        &self,
        display_id: i64,
        revealed: bool,
    ) -> Result<(), String> {
        let tab_ids = {
            let mut state = self.state().map_err(|error| error.message)?;
            let host = state
                .display_hosts
                .get_mut(&display_id)
                .ok_or_else(|| "Runtime display host was not found".to_owned())?;
            host.toolbar_revealed = revealed;
            state
                .tabs
                .iter()
                .filter_map(|(tab_id, tab)| {
                    (tab.display_id == display_id).then_some(tab_id.clone())
                })
                .collect::<Vec<_>>()
        };
        for tab_id in tab_ids {
            self.layout_runtime_tab(&tab_id)
                .map_err(|error| error.message)?;
        }
        self.publish_projection();
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn set_windows_toolbar_revealed(
        &self,
        _display_id: i64,
        _revealed: bool,
    ) -> Result<(), String> {
        Err("Windows runtime tab strip is unavailable on this platform".to_owned())
    }

    pub fn handle_divider_pointer(
        &self,
        webview_label: &str,
        payload: DividerPointerPayload,
    ) -> Result<(), String> {
        if !matches!(payload.phase.as_str(), "start" | "move" | "end" | "reset") {
            return Err("divider pointer phase is invalid".to_owned());
        }
        let context = {
            let mut state = self.state().map_err(|error| error.message)?;
            let Some((tab_id, tab)) = state.tabs.iter_mut().find(|(_, tab)| {
                tab.dividers
                    .iter()
                    .any(|divider| divider.webview.label() == webview_label)
            }) else {
                return Err("divider bridge is not authorized for this WebView".to_owned());
            };
            let divider = tab
                .dividers
                .iter()
                .find(|divider| divider.webview.label() == webview_label)
                .ok_or_else(|| "runtime divider was not found".to_owned())?;
            if payload.phase == "end" {
                let active = tab.active_divider_resize.take();
                let role_ids = active.map(|value| value.role_ids).unwrap_or_default();
                drop(state);
                self.send_divider_indicators(&role_ids, "hide");
                return Ok(());
            }
            let previous = tab
                .active_divider_resize
                .as_ref()
                .filter(|active| active.divider_index == divider.index)
                .map(|active| active.snapped_position);
            let tab_context = (
                tab_id.clone(),
                divider.index,
                divider.descriptor.clone(),
                tab.dividers
                    .iter()
                    .map(|divider| divider.descriptor.clone())
                    .collect::<Vec<_>>(),
                tab.roles
                    .iter()
                    .map(|(role_id, role)| LayoutRoleInput {
                        role_id: role_id.clone(),
                        rect: LayoutRect {
                            x: role.rect.x,
                            y: role.rect.y,
                            width: role.rect.width,
                            height: role.rect.height,
                        },
                    })
                    .collect::<Vec<_>>(),
                tab.display_id,
                previous,
            );
            let host = state.display_hosts.get(&tab_context.5).ok_or_else(|| {
                "runtime display host was not found for divider WebView".to_owned()
            })?;
            #[cfg(windows)]
            let toolbar_revealed = host.toolbar_revealed;
            #[cfg(not(windows))]
            let toolbar_revealed = false;
            (
                tab_context.0,
                tab_context.1,
                tab_context.2,
                tab_context.3,
                tab_context.4,
                host.window.clone(),
                tab_context.6,
                toolbar_revealed,
            )
        };
        let (tab_id, divider_index, divider, dividers, roles, window, previous, _toolbar_revealed) =
            context;
        let requested_position = if payload.phase == "reset" {
            divider.default_position
        } else {
            let screen_position = payload
                .screen_position
                .filter(|value| value.is_finite())
                .ok_or_else(|| "divider screen position is invalid".to_owned())?;
            let scale = window.scale_factor().map_err(|error| error.to_string())?;
            let position = window.inner_position().map_err(|error| error.to_string())?;
            #[cfg(windows)]
            let metrics = runtime_window_content_metrics_with_tab_strip(
                &window,
                self.windows_tab_strip_height(&window, _toolbar_revealed),
            )
            .map_err(|error| error.message)?;
            #[cfg(not(windows))]
            let metrics = runtime_window_content_metrics(&window).map_err(|error| error.message)?;
            if divider.axis == "vertical" {
                (screen_position - position.x as f64 / scale) / metrics.width.max(1.0)
            } else {
                (screen_position - position.y as f64 / scale - metrics.top_inset)
                    / metrics.height.max(1.0)
            }
        };
        let result = self
            .core
            .invoke(CoreCommand::LayoutResizeDivider {
                input: WorkspaceDividerResizeInput {
                    roles,
                    dividers,
                    divider_index,
                    requested_position,
                    previous_position: (payload.phase == "move").then_some(previous).flatten(),
                },
            })
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<WorkspaceDividerResizeOutput>(value)
                    .map_err(|error| error.to_string())
            })?;
        {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab = state
                .tabs
                .get_mut(&tab_id)
                .ok_or_else(|| "runtime tab was closed during divider resize".to_owned())?;
            for role in &result.roles {
                if let Some(surface) = tab.roles.get_mut(&role.role_id) {
                    surface.rect = StateNormalizedRectRecord {
                        x: role.rect.x,
                        y: role.rect.y,
                        width: role.rect.width,
                        height: role.rect.height,
                    };
                }
            }
            if payload.phase == "start" {
                tab.active_divider_resize = Some(ActiveDividerResize {
                    divider_index,
                    role_ids: result.role_ids.clone(),
                    snapped_position: result.position,
                });
            } else if payload.phase == "move"
                && let Some(active) = tab.active_divider_resize.as_mut()
            {
                active.role_ids = result.role_ids.clone();
                active.snapped_position = result.position;
            } else if payload.phase == "reset" {
                tab.active_divider_resize = None;
            }
        }
        if result.changed {
            self.layout_runtime_tab(&tab_id)
                .map_err(|error| error.message)?;
        }
        let indicator_type = if payload.phase == "start" {
            "show"
        } else {
            "update"
        };
        self.send_divider_indicators(&result.role_ids, indicator_type);
        if payload.phase == "reset" {
            self.send_divider_indicators(&result.role_ids, "hide");
        }
        let _ = self.persist_restore_session(false);
        Ok(())
    }

    fn send_divider_indicators(&self, role_ids: &[String], indicator_type: &str) {
        let surfaces = self.state.lock().ok().map(|state| {
            role_ids
                .iter()
                .filter_map(|role_id| {
                    let tab_id = state.role_tabs.get(role_id)?;
                    let role = state.tabs.get(tab_id)?.roles.get(role_id)?;
                    Some((role.webview.clone(), role.rect.clone()))
                })
                .collect::<Vec<_>>()
        });
        for (webview, rect) in surfaces.unwrap_or_default() {
            let payload = if indicator_type == "hide" {
                json!({ "type": "hide" })
            } else {
                json!({
                    "type": indicator_type,
                    "label": format!("{} × {}", format_ratio(rect.width), format_ratio(rect.height))
                })
            };
            let _ = webview.eval(format!(
                "globalThis.__rionStudioWorkspaceResizeIndicator?.({payload});"
            ));
        }
    }

    pub fn toggle_focused_runtime_fullscreen(&self) -> Result<bool, String> {
        let window = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| host.window.clone())
        };
        let Some(window) = window else {
            return Ok(false);
        };
        let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
        #[cfg(target_os = "macos")]
        self.prepare_runtime_window_fullscreen(window.label(), !fullscreen);
        window
            .set_fullscreen(!fullscreen)
            .map_err(|error| error.to_string())?;
        Ok(true)
    }

    pub fn zoom_focused_runtime(&self, action: &str) -> Result<bool, String> {
        let display_id = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| host.target.display_id)
        };
        let Some(display_id) = display_id else {
            return Ok(false);
        };
        let snapshot = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                    .map_err(|error| error.to_string())
            })?;
        let Some(tab_id) = snapshot
            .displays
            .iter()
            .find(|display| display.display_id == display_id)
            .and_then(|display| display.active_tab_id.as_deref())
        else {
            return Ok(false);
        };
        let surfaces = {
            let state = self.state().map_err(|error| error.message)?;
            let Some(tab) = state.tabs.get(tab_id) else {
                return Ok(false);
            };
            tab.roles
                .iter()
                .map(|(role_id, surface)| {
                    let zoom = match action {
                        "in" => (surface.zoom_factor + 0.1).min(5.0),
                        "out" => (surface.zoom_factor - 0.1).max(0.25),
                        _ => 1.0,
                    };
                    (role_id.clone(), surface.webview.clone(), zoom)
                })
                .collect::<Vec<_>>()
        };
        for (_, webview, zoom) in &surfaces {
            webview.set_zoom(*zoom).map_err(|error| error.to_string())?;
        }
        let mut state = self.state().map_err(|error| error.message)?;
        for (role_id, _, zoom) in surfaces {
            if let Some(tab_id) = state.role_tabs.get(&role_id).cloned()
                && let Some(surface) = state
                    .tabs
                    .get_mut(&tab_id)
                    .and_then(|tab| tab.roles.get_mut(&role_id))
            {
                surface.zoom_factor = zoom;
            }
        }
        Ok(true)
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
            let display_hosts = std::mem::take(&mut state.display_hosts);
            let compatibility = std::mem::take(&mut state.compatibility);
            let popup_labels = std::mem::take(&mut state.popup_roles)
                .into_keys()
                .collect::<Vec<_>>();
            state.audible_webviews.clear();
            state.role_tabs.clear();
            state.allow_window_close_labels.extend(
                display_hosts
                    .values()
                    .map(|host| host.window.label().to_owned())
                    .chain(
                        compatibility
                            .values()
                            .map(|surface| surface.window.label().to_owned()),
                    ),
            );
            drop(state);
            for (_, tab) in tabs {
                for role_id in tab.roles.keys() {
                    self.clear_role_keys(role_id);
                }
            }
            for (_, host) in display_hosts {
                let _ = host.window.close();
            }
            for (_, surface) in compatibility {
                let _ = surface.window.close();
            }
            for label in popup_labels {
                if let Some(window) = self.app.get_webview_window(&label) {
                    let _ = window.close();
                }
            }
        }
    }

    pub fn projection(&self, snapshot: &BrowserRuntimeSnapshot) -> Value {
        let role_names = self
            .core
            .invoke(CoreCommand::RolesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateRoleRecord>>(value).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|role| (role.id, role.name))
            .collect::<HashMap<_, _>>();
        let (tabs, window_inputs, saved_windows, recovery) = {
            let Ok(state) = self.state.lock() else {
                return json!({ "windows": [], "tabs": [] });
            };
            let tabs = snapshot
                .tabs
                .iter()
                .map(|tab| {
                    let active = snapshot.displays.iter().any(|display| {
                        display.active_tab_id.as_deref() == Some(tab.id.as_str())
                    });
                    let audio_muted = state
                        .tabs
                        .get(&tab.id)
                        .is_some_and(|runtime_tab| runtime_tab.audio_muted);
                    let audible = state
                        .tabs
                        .get(&tab.id)
                        .is_some_and(|runtime_tab| runtime_tab_is_audible(&state, runtime_tab));
                    json!({
                        "id": tab.id,
                        "type": if tab.tab_type == "workspace" { "workspace" } else { "role" },
                        "sourceId": tab.source_id,
                        "name": tab.name,
                        "displayId": tab.display_id,
                        "roleIds": tab.role_ids,
                        "roleNames": tab.role_ids.iter().filter_map(|role_id| role_names.get(role_id).cloned()).collect::<Vec<_>>(),
                        "hidden": tab.hidden,
                        "active": active,
                        "audible": audible,
                        "audioMuted": audio_muted
                    })
                })
                .collect::<Vec<_>>();
            let window_inputs = snapshot
                .displays
                .iter()
                .filter_map(|display| {
                    let tab_id = display.active_tab_id.as_ref()?;
                    let host = state.display_hosts.get(&display.display_id)?;
                    Some((
                        host.window.label().to_owned(),
                        display.display_id,
                        host.target.work_area.clone(),
                        host.window.clone(),
                        tab_id.clone(),
                        display.tab_ids.len(),
                    ))
                })
                .collect::<Vec<_>>();
            let saved_windows = state
                .dormant_windows
                .iter()
                .map(|window| {
                    let display_label = window
                        .target_display
                        .fingerprint
                        .as_ref()
                        .map(|fingerprint| fingerprint.label.trim())
                        .filter(|label| !label.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("Display {}", window.target_display.id));
                    let role_count = window
                        .tabs
                        .iter()
                        .flat_map(|tab| tab.role_ids.iter())
                        .collect::<HashSet<_>>()
                        .len();
                    json!({
                        "id": window.id,
                        "displayId": window.target_display.id,
                        "displayLabel": display_label,
                        "wasVisible": window.was_visible,
                        "activeSourceId": window.active_source_id,
                        "tabCount": window.tabs.len(),
                        "roleCount": role_count,
                        "tabNames": window.tabs.iter().map(|tab| tab.name.clone()).collect::<Vec<_>>(),
                        "state": "saved"
                    })
                })
                .collect::<Vec<_>>();
            let recovery = state.recovery_required.then(|| {
                json!({
                    "reason": "unclean-exit",
                    "windowCount": saved_windows.len(),
                    "tabCount": state.dormant_windows.iter().map(|window| window.tabs.len()).sum::<usize>()
                })
            });
            (tabs, window_inputs, saved_windows, recovery)
        };
        let windows = window_inputs
            .into_iter()
            .map(|(id, display_id, bounds, window, tab_id, tab_count)| {
                json!({
                    "id": id,
                    "displayId": display_id,
                    "bounds": bounds,
                    "visible": window.is_visible().unwrap_or(false),
                    "focused": window.is_focused().unwrap_or(false),
                    "activeTabId": tab_id,
                    "tabCount": tab_count
                })
            })
            .collect::<Vec<_>>();
        json!({
            "windows": windows,
            "tabs": tabs,
            "savedWindows": saved_windows,
            "recovery": recovery
        })
    }

    pub fn begin_auto_restore(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.auto_restore_attempted
            || state.recovery_required
            || state.dormant_windows.is_empty()
        {
            return false;
        }
        state.auto_restore_attempted = true;
        true
    }

    pub fn replace_dormant_windows(
        &self,
        windows: Vec<RuntimeRestoreWindowRecord>,
        recovery_required: bool,
    ) {
        if let Ok(mut state) = self.state.lock() {
            state.dormant_windows = windows;
            state.recovery_required = recovery_required && !state.dormant_windows.is_empty();
        }
        self.publish_projection();
    }

    pub fn publish_projection(&self) {
        let Ok(value) = self.core.invoke(CoreCommand::BrowserRuntimeSnapshot) else {
            return;
        };
        let Ok(snapshot) = serde_json::from_value::<BrowserRuntimeSnapshot>(value) else {
            return;
        };
        #[cfg(target_os = "macos")]
        self.sync_native_tab_strip(&snapshot);
        #[cfg(windows)]
        self.sync_windows_tab_strip(&snapshot);
        let _ = self
            .app
            .emit("rion://runtime-state", self.projection(&snapshot));
    }

    pub fn restore_tab_audio_muted(&self, source_id: &str, muted: bool) -> Result<(), String> {
        let snapshot = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                    .map_err(|error| error.to_string())
            })?;
        let role_id = snapshot
            .tabs
            .iter()
            .find(|tab| tab.source_id == source_id)
            .and_then(|tab| tab.role_ids.first())
            .ok_or_else(|| "The restored runtime tab has no role surface.".to_owned())?;
        self.set_role_audio_muted(role_id, muted)
            .map_err(|error| error.message)
    }

    pub fn handle_window_close_requested(&self, label: &str) -> bool {
        let window = {
            let Ok(mut state) = self.state.lock() else {
                return false;
            };
            if state.allow_window_close_labels.remove(label) {
                return false;
            }
            let Some(window) = state
                .display_hosts
                .values()
                .find(|host| host.window.label() == label)
                .map(|host| host.window.clone())
            else {
                return false;
            };
            state.pending_window_close_labels.remove(label);
            window
        };
        let _ = window.hide();
        self.publish_projection();
        let _ = self.persist_restore_session(false);
        true
    }

    pub fn resize_window(&self, label: &str, physical_width: u32, physical_height: u32) {
        let Some((display_id, window)) = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .iter()
                .find(|(_, host)| host.window.label() == label)
                .map(|(display_id, host)| (*display_id, host.window.clone()))
        }) else {
            return;
        };
        let scale_factor = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
        let width = (physical_width as f64 / scale_factor).max(1.0);
        let height = (physical_height as f64 / scale_factor).max(1.0);
        if let Ok(mut state) = self.state.lock()
            && let Some(host) = state.display_hosts.get_mut(&display_id)
        {
            host.target.work_area.width = width.round() as i32;
            host.target.work_area.height = height.round() as i32;
        }
        let tab_ids = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .tabs
                    .iter()
                    .filter_map(|(tab_id, tab)| {
                        (tab.display_id == display_id).then_some(tab_id.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for tab_id in tab_ids {
            let _ = self.layout_runtime_tab(&tab_id);
        }
        self.publish_projection();
    }

    pub fn schedule_resize_window(
        self: &Arc<Self>,
        label: String,
        physical_width: u32,
        physical_height: u32,
    ) {
        let should_spawn = self.state.lock().ok().is_some_and(|mut state| {
            state
                .pending_window_resizes
                .insert(label.clone(), (physical_width, physical_height));
            state.active_window_resize_workers.insert(label.clone())
        });
        if !should_spawn {
            return;
        }
        let runtime = Arc::clone(self);
        let worker_label = label.clone();
        if std::thread::Builder::new()
            .name("rion-runtime-window-resize".to_owned())
            .spawn(move || {
                loop {
                    let next = runtime.state.lock().ok().and_then(|mut state| {
                        let next = state.pending_window_resizes.remove(&worker_label);
                        if next.is_none() {
                            state.active_window_resize_workers.remove(&worker_label);
                        }
                        next
                    });
                    let Some((width, height)) = next else {
                        break;
                    };
                    runtime.resize_window(&worker_label, width, height);
                }
            })
            .is_err()
            && let Ok(mut state) = self.state.lock()
        {
            state.active_window_resize_workers.remove(&label);
            state.pending_window_resizes.remove(&label);
        }
    }

    #[cfg(target_os = "macos")]
    pub fn prepare_runtime_window_fullscreen(&self, label: &str, fullscreen: bool) {
        let controller = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .values()
                .find(|host| host.window.label() == label)
                .map(|host| host.tabs_controller.clone())
        });
        if let Some(controller) = controller {
            controller.prepare_fullscreen(fullscreen);
        }
    }

    pub fn persist_restore_session(&self, clean_exit: bool) -> Result<(), String> {
        let snapshot = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                    .map_err(|error| error.to_string())
            })?;
        let (live_windows, dormant_windows) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let mut live_sources = HashSet::new();
            let mut live_role_ids = HashSet::new();
            let mut live_windows = Vec::new();
            for display in &snapshot.displays {
                let tabs = snapshot
                    .tabs
                    .iter()
                    .filter(|tab| tab.display_id == display.display_id)
                    .filter_map(|tab| {
                        let runtime_tab = state.tabs.get(&tab.id)?;
                        live_sources.insert(format!("{}:{}", tab.tab_type, tab.source_id));
                        live_role_ids.extend(tab.role_ids.iter().cloned());
                        Some(RuntimeRestoreTabRecord {
                            tab_type: tab.tab_type.clone(),
                            source_id: tab.source_id.clone(),
                            name: tab.name.clone(),
                            role_ids: tab.role_ids.clone(),
                            hidden: tab.hidden,
                            audio_muted: runtime_tab.audio_muted,
                        })
                    })
                    .collect::<Vec<_>>();
                if tabs.is_empty() {
                    continue;
                }
                let active_tab = display
                    .active_tab_id
                    .as_ref()
                    .and_then(|tab_id| snapshot.tabs.iter().find(|tab| &tab.id == tab_id));
                let active_runtime = display
                    .active_tab_id
                    .as_ref()
                    .and_then(|_| state.display_hosts.get(&display.display_id));
                let id = format!("display-{}", display.display_id);
                live_windows.push((
                    RuntimeRestoreWindowRecord {
                        id,
                        target_display: StateWorkspaceDisplayTargetRecord {
                            id: display.display_id,
                            fingerprint: None,
                        },
                        was_visible: false,
                        active_source_id: active_tab.map(|tab| tab.source_id.clone()),
                        tabs,
                    },
                    active_runtime.map(|host| host.window.clone()),
                ));
            }
            let dormant_windows = state
                .dormant_windows
                .iter()
                .filter_map(|window| {
                    let tabs = window
                        .tabs
                        .iter()
                        .filter(|tab| {
                            !live_sources.contains(&format!("{}:{}", tab.tab_type, tab.source_id))
                                && !tab
                                    .role_ids
                                    .iter()
                                    .any(|role_id| live_role_ids.contains(role_id))
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    (!tabs.is_empty()).then(|| RuntimeRestoreWindowRecord {
                        tabs,
                        ..window.clone()
                    })
                })
                .collect::<Vec<_>>();
            (live_windows, dormant_windows)
        };
        let mut last_focused_window_id = None;
        let mut windows = live_windows
            .into_iter()
            .map(|(mut record, window)| {
                if let Some(window) = window {
                    if window.is_focused().unwrap_or(false) {
                        last_focused_window_id = Some(record.id.clone());
                    }
                    record.was_visible = window.is_visible().unwrap_or(false);
                }
                record
            })
            .collect::<Vec<_>>();
        windows.extend(dormant_windows);
        self.core
            .invoke(CoreCommand::RuntimeRestoreSessionReplace {
                session: RuntimeRestoreSessionRecord {
                    schema_version: 1,
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    clean_exit,
                    last_focused_window_id,
                    windows,
                },
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn take_macro_page_request(&self) -> Option<Value> {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_macro_page_request.take())
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub(crate) fn evaluate_role_for_attestation(
        &self,
        role_id: &str,
        source: &str,
    ) -> Result<Value, String> {
        let webview = self.role_webview(role_id).map_err(|error| error.message)?;
        evaluate_attestation_value(&webview, source).map_err(|error| error.message)
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub(crate) fn restore_state_for_attestation(&self) -> Result<Value, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        Ok(json!({
            "dormantWindowCount": state.dormant_windows.len(),
            "liveTabCount": state.tabs.len(),
            "recoveryRequired": state.recovery_required
        }))
    }

    pub fn role_id_for_webview(&self, webview_label: &str) -> Result<String, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        if let Some(role_id) = state.popup_roles.get(webview_label) {
            return Ok(role_id.clone());
        }
        state
            .role_tabs
            .iter()
            .find_map(|(role_id, tab_id)| {
                state.tabs.get(tab_id).and_then(|tab| {
                    tab.roles
                        .get(role_id)
                        .filter(|surface| surface.webview.label() == webview_label)
                        .map(|_| role_id.clone())
                })
            })
            .ok_or_else(|| "Overlay WebView is not associated with a running role.".to_owned())
    }

    pub fn set_webview_audible(
        &self,
        webview_label: &str,
        role_id: &str,
        audible: bool,
    ) -> Result<(), String> {
        let changed = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let belongs_to_role = state
                .popup_roles
                .get(webview_label)
                .is_some_and(|id| id == role_id)
                || state.role_tabs.get(role_id).is_some_and(|tab_id| {
                    state.tabs.get(tab_id).is_some_and(|tab| {
                        tab.roles
                            .get(role_id)
                            .is_some_and(|surface| surface.webview.label() == webview_label)
                    })
                });
            if !belongs_to_role {
                return Err("Audio state source is not associated with this role.".to_owned());
            }
            let previous = state
                .audible_webviews
                .get(webview_label)
                .copied()
                .unwrap_or(false);
            if audible {
                state
                    .audible_webviews
                    .insert(webview_label.to_owned(), true);
            } else {
                state.audible_webviews.remove(webview_label);
            }
            previous != audible
        };
        if changed {
            self.publish_projection();
        }
        Ok(())
    }

    pub fn handle_web_content_process_terminated(
        self: &Arc<Self>,
        webview_label: &str,
        reason: &str,
    ) {
        let role_id = self.role_id_for_webview(webview_label).ok();
        let Some(role_id) = role_id else {
            return;
        };
        self.schedule_surface_recovery(role_id, reason.to_owned());
    }

    pub fn forget_popup(&self, window_label: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.popup_roles.remove(window_label);
            state.audible_webviews.remove(window_label);
        }
        self.publish_projection();
    }

    fn register_popup(&self, window_label: String, role_id: String) {
        if let Ok(mut state) = self.state.lock() {
            state.popup_roles.insert(window_label, role_id);
        }
    }

    fn schedule_surface_recovery(self: &Arc<Self>, role_id: String, reason: String) {
        let allowed = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if !state.role_tabs.contains_key(&role_id)
                || !state.recovering_roles.insert(role_id.clone())
            {
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
        let runtime = Arc::clone(self);
        let _ = std::thread::Builder::new()
            .name("rion-system-surface-recovery".to_owned())
            .spawn(move || runtime.recover_system_surface(role_id, reason, allowed));
    }

    fn recover_system_surface(&self, role_id: String, reason: String, allowed: bool) {
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

    fn rebuild_role_surface(&self, role_id: &str) -> RuntimeResult<()> {
        let (window, old_webview, rect, current_url, zoom_factor, audio_muted, generation) = {
            let mut state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found during System WebView recovery.",
                )
            })?;
            let (display_id, old_webview, rect, current_url, zoom_factor, audio_muted) = {
                let tab = state.tabs.get(&tab_id).ok_or_else(|| {
                    RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
                })?;
                let role = tab.roles.get(role_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role surface was not found during recovery.",
                    )
                })?;
                let current_url = role.current_url.clone().ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_RECOVERY_URL_MISSING",
                        "The crashed System WebView has no recoverable URL.",
                    )
                })?;
                (
                    tab.display_id,
                    role.webview.clone(),
                    role.rect.clone(),
                    current_url,
                    role.zoom_factor,
                    tab.audio_muted,
                )
            };
            let window = state
                .display_hosts
                .get(&display_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "Runtime display host was not found during recovery.",
                    )
                })?;
            let next_generation = state
                .recovery_generations
                .entry(role_id.to_owned())
                .or_insert(0);
            *next_generation += 1;
            (
                window,
                old_webview,
                rect,
                current_url,
                zoom_factor,
                audio_muted,
                *next_generation,
            )
        };
        let navigation = Arc::new(NavigationTracker::default());
        let callback_navigation = Arc::clone(&navigation);
        let paths = role_session_paths(&self.user_data_dir, role_id)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let builder = self
            .webview_builder(
                format!(
                    "{}-recovery-{generation}",
                    runtime_label("game-role", role_id)
                ),
                &paths,
                Some(role_id),
            )?
            .on_page_load(move |_webview, payload| {
                callback_navigation.page_event(payload.event(), payload.url());
            });
        let bounds = role_bounds_for_content(runtime_window_content_metrics(&window)?, &rect);
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(RuntimeError::tauri)?;
        install_platform_security_policy(&webview)?;
        install_process_failure_monitor(&webview, self.app.clone(), role_id.to_owned())?;
        webview.set_zoom(zoom_factor).map_err(RuntimeError::tauri)?;
        navigation.reset();
        webview
            .navigate(current_url.clone())
            .map_err(RuntimeError::tauri)?;
        navigation
            .wait()
            .map_err(|message| RuntimeError::new("SYSTEM_SURFACE_RECOVERY_FAILED", message))?;
        if audio_muted {
            set_audio_muted(&webview, true)?;
        }
        let _ = old_webview.close();
        let tab_id = {
            let mut state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role stopped while its System WebView was recovering.",
                )
            })?;
            let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            tab.roles.insert(
                role_id.to_owned(),
                RoleSurface {
                    current_url: Some(current_url),
                    navigation,
                    rect,
                    webview,
                    zoom_factor,
                },
            );
            tab_id
        };
        self.layout_runtime_tab(&tab_id)
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
            CoreEffectAction::RoleBrowserDataClearSession {
                role_id,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => {
                self.clear_role_browser_data(
                    &role_id,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                )?;
                Ok(None)
            }
            CoreEffectAction::CompatibilityCreateWindow { plan } => {
                self.create_compatibility_surface(plan)?;
                Ok(None)
            }
            CoreEffectAction::CompatibilityConfigureSession { game_id } => {
                self.require_compatibility_surface(&game_id)?;
                Ok(None)
            }
            CoreEffectAction::CompatibilityLoadUrl { game_id, url } => self
                .load_compatibility_url(&game_id, &url)
                .map(|final_url| Some(json!({ "finalUrl": final_url }).to_string())),
            CoreEffectAction::CompatibilityProbeGraphics { game_id, source } => {
                let webview = self.compatibility_webview(&game_id)?;
                self.evaluate_webview(&webview, &source).map(Some)
            }
            CoreEffectAction::CompatibilityCleanupWindow { game_id } => {
                self.cleanup_compatibility_surface(&game_id)?;
                Ok(None)
            }
            CoreEffectAction::OverlayOpenMacroPage { role_id } => {
                let request = json!({ "roleId": role_id });
                self.state()?.pending_macro_page_request = Some(request.clone());
                let _ = self.app.emit("rion://macro-page-request", request);
                Ok(None)
            }
            CoreEffectAction::OverlayCopyCoordinate { coordinate } => {
                crate::native_shell::copy_text(&format!(
                    "X: {}px ({}%), Y: {}px ({}%), Viewport: {}x{}px",
                    coordinate.x_px,
                    coordinate.x_percent,
                    coordinate.y_px,
                    coordinate.y_percent,
                    coordinate.viewport_width_px,
                    coordinate.viewport_height_px
                ))
                .map_err(|message| RuntimeError::new("SHELL_CLIPBOARD_FAILED", message))?;
                Ok(None)
            }
            CoreEffectAction::BrowserAction { request } => self.browser_action(*request),
        }
    }

    fn browser_action(&self, request: BrowserActionRequest) -> RuntimeResult<Option<String>> {
        if request.request_id.is_empty() || request.role_id.is_empty() {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_INVALID",
                "Browser action identifiers are required.",
            ));
        }
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        if now_ms > request.deadline_ms {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_DEADLINE",
                "Browser action deadline expired.",
            ));
        }
        match request.action {
            BrowserAction::Focus => {
                self.prepare_automation_focus(&request.role_id)?;
                Ok(None)
            }
            BrowserAction::Evaluate { source } => {
                let webview = self.role_webview(&request.role_id)?;
                self.evaluate_webview(&webview, &source).map(Some)
            }
            BrowserAction::Key {
                phase,
                key,
                code,
                modifiers,
                owner_id,
                suppress_overlay_shortcut: _,
            } => {
                let code = code.filter(|value| !value.is_empty()).unwrap_or(key);
                self.dispatch_key_action(&request.role_id, &phase, &code, &modifiers, &owner_id)?;
                Ok(None)
            }
            BrowserAction::Click {
                anchor,
                unit,
                x,
                y,
                button,
            } => {
                self.dispatch_click_action(
                    &request.role_id,
                    anchor.as_deref(),
                    &unit,
                    x,
                    y,
                    &button,
                )?;
                Ok(None)
            }
            BrowserAction::Cookies { .. } => Err(RuntimeError::new(
                "BROWSER_COOKIES_UNAVAILABLE",
                "Cookie automation is not exposed by the system runtime.",
            )),
            BrowserAction::Session { .. } => Err(RuntimeError::new(
                "BROWSER_SESSION_UNAVAILABLE",
                "Session automation is not exposed by the system runtime.",
            )),
            BrowserAction::Debugger {
                method,
                params_json,
            } => {
                let params = parse_devtools_params(&params_json)?;
                let webview = self.role_webview(&request.role_id)?;
                call_system_devtools(&webview, &method, &params).map(Some)
            }
        }
    }

    fn dispatch_key_action(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifiers: &[String],
        owner_id: &str,
    ) -> RuntimeResult<()> {
        let webview = self.role_webview(role_id)?;
        let modifier_codes = resolve_modifier_codes(modifiers, cfg!(target_os = "macos"))?;
        let transition =
            self.prepare_key_transition(role_id, phase, code, modifier_codes, owner_id)?;
        let mut executed = Vec::new();
        let dispatch_result = transition.effects.iter().try_for_each(|effect| {
            executed.push(effect.clone());
            dispatch_key_effect(&webview, effect)
        });
        match dispatch_result {
            Ok(()) => {
                if let Err(error) = self.complete_key_transition(&transition, true) {
                    for effect in executed.iter().rev() {
                        let compensation = compensated_key_effect(effect);
                        let _ = dispatch_key_effect(&webview, &compensation);
                    }
                    let _ = self.complete_key_transition(&transition, false);
                    return Err(error);
                }
                Ok(())
            }
            Err(error) => {
                for effect in executed.iter().rev() {
                    let compensation = compensated_key_effect(effect);
                    let _ = dispatch_key_effect(&webview, &compensation);
                }
                let _ = self.complete_key_transition(&transition, false);
                Err(error)
            }
        }
    }

    fn dispatch_click_action(
        &self,
        role_id: &str,
        anchor: Option<&str>,
        unit: &str,
        x: f64,
        y: f64,
        button: &str,
    ) -> RuntimeResult<()> {
        let webview = self.role_webview(role_id)?;
        let viewport = self.devtools_viewport(&webview)?;
        let point = resolve_click_point(anchor, unit, x, y, viewport)?;
        dispatch_mouse_effect(&webview, point, validate_mouse_button(button)?, true)?;
        if let Err(error) =
            dispatch_mouse_effect(&webview, point, validate_mouse_button(button)?, false)
        {
            let _ = dispatch_mouse_effect(&webview, point, validate_mouse_button(button)?, false);
            return Err(error);
        }
        Ok(())
    }

    fn devtools_viewport(&self, webview: &Webview) -> RuntimeResult<ViewportSize> {
        if let Ok(result) = call_system_devtools(webview, "Page.getLayoutMetrics", &json!({}))
            && let Some(viewport) = parse_devtools_viewport(&result)
        {
            return Ok(viewport);
        }
        let result = self.evaluate_webview(
            webview,
            "({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) })",
        )?;
        parse_evaluated_viewport(&result).ok_or_else(|| {
            RuntimeError::new(
                "BROWSER_VIEWPORT_UNAVAILABLE",
                "System WebView viewport size is unavailable.",
            )
        })
    }

    fn prepare_key_transition(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifier_codes: Vec<String>,
        owner_id: &str,
    ) -> RuntimeResult<EmbeddedKeyTransitionRecord> {
        self.core
            .invoke(CoreCommand::EmbeddedKeyPrepare {
                role_id: role_id.to_owned(),
                phase: phase.to_owned(),
                code: code.to_owned(),
                modifier_codes,
                owner_id: owner_id.to_owned(),
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value(value).map_err(|error| {
                    RuntimeError::new("TAURI_CORE_RESULT_INVALID", error.to_string())
                })
            })
    }

    fn complete_key_transition(
        &self,
        transition: &EmbeddedKeyTransitionRecord,
        succeeded: bool,
    ) -> RuntimeResult<()> {
        let Some(transition_id) = &transition.transition_id else {
            return Ok(());
        };
        self.core
            .invoke(CoreCommand::EmbeddedKeyComplete {
                transition_id: transition_id.clone(),
                succeeded,
            })
            .map(|_| ())
            .map_err(RuntimeError::core)
    }

    fn reassert_role_keys(&self, role_id: &str, webview: &Webview) -> RuntimeResult<()> {
        if !cfg!(windows) {
            return Ok(());
        }
        let transition = self
            .core
            .invoke(CoreCommand::EmbeddedKeysReassert {
                role_id: role_id.to_owned(),
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value::<EmbeddedKeyTransitionRecord>(value).map_err(|error| {
                    RuntimeError::new("TAURI_CORE_RESULT_INVALID", error.to_string())
                })
            })?;
        transition
            .effects
            .iter()
            .try_for_each(|effect| dispatch_key_effect(webview, effect))
    }

    fn clear_role_keys(&self, role_id: &str) {
        let _ = self.core.invoke(CoreCommand::EmbeddedKeysClear {
            role_id: role_id.to_owned(),
        });
    }

    fn prepare_automation_focus(&self, role_id: &str) -> RuntimeResult<()> {
        let webview = self.role_webview(role_id)?;
        self.evaluate_webview(
            &webview,
            "(() => { try { window.focus(); const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body; target?.focus?.({ preventScroll: true }); return true; } catch { return false; } })()",
        )
        .map(|_| ())
    }

    fn webview_builder(
        &self,
        label: String,
        paths: &SessionPaths,
        role_id: Option<&str>,
    ) -> RuntimeResult<WebviewBuilder<tauri::Wry>> {
        let blank = "about:blank"
            .parse()
            .map_err(|_| RuntimeError::new("TAURI_URL_INVALID", "Invalid blank URL."))?;
        let popup_app = self.app.clone();
        let popup_role_id = role_id.map(str::to_owned);
        let popup_webview2_data_directory = paths.webview2.clone();
        let popup_webkit_data_store_identifier = paths.webkit_identifier;
        #[cfg(windows)]
        let popup_additional_browser_arguments =
            self.configuration.additional_browser_arguments.clone();
        let popup_document_start_script = [
            self.configuration.document_start_script.clone(),
            self.configuration.overlay_document_start_script.clone(),
        ]
        .join("\n");
        let download_app = self.app.clone();
        let download_role_id = role_id.map(str::to_owned);
        let shortcut_core = Arc::clone(&self.core);
        let shortcut_role_id = role_id.map(str::to_owned);
        #[cfg(any(windows, target_os = "macos"))]
        let download_attestation = self.configuration.download_attestation.clone();
        #[cfg(any(windows, target_os = "macos"))]
        let popup_download_attestation = download_attestation.clone();
        let mut builder = WebviewBuilder::new(label, WebviewUrl::External(blank))
            .data_directory(paths.webview2.clone())
            .data_store_identifier(paths.webkit_identifier)
            .initialization_script_for_all_frames(&self.configuration.document_start_script)
            .enable_clipboard_access()
            .zoom_hotkeys_enabled(false)
            .on_navigation(move |url| {
                if url.scheme() == "rion-runtime-shortcut" {
                    if let Some(role_id) = shortcut_role_id.as_ref() {
                        let direction = if url.path() == "/previous" {
                            "previous"
                        } else {
                            "next"
                        }
                        .to_owned();
                        if let Ok(snapshot) = shortcut_core
                            .invoke(CoreCommand::BrowserRuntimeSnapshot)
                            .and_then(|value| {
                                serde_json::from_value::<BrowserRuntimeSnapshot>(value).map_err(
                                    |error| rion_core::CoreError::Internal(error.to_string()),
                                )
                            })
                            && let Some(display_id) = snapshot
                                .tabs
                                .iter()
                                .find(|tab| tab.role_ids.iter().any(|id| id == role_id))
                                .map(|tab| tab.display_id)
                        {
                            let core = Arc::clone(&shortcut_core);
                            tauri::async_runtime::spawn(async move {
                                let _ = core
                                    .invoke_async(CoreCommand::EmbeddedTabActivateAdjacent {
                                        display_id,
                                        direction,
                                    })
                                    .await;
                            });
                        }
                    }
                    return false;
                }
                matches!(url.scheme(), "about" | "http" | "https")
            })
            .on_new_window(move |url, features| {
                let Some(role_id) = popup_role_id.as_ref() else {
                    return NewWindowResponse::Deny;
                };
                if !matches!(url.scheme(), "about" | "http" | "https") {
                    return NewWindowResponse::Deny;
                }
                let sequence = POPUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let label = runtime_label("game-role-popup", &format!("{role_id}:{sequence}"));
                let blank = match "about:blank".parse() {
                    Ok(blank) => blank,
                    Err(_) => return NewWindowResponse::Deny,
                };
                let popup_download_app = popup_app.clone();
                let popup_download_role_id = role_id.clone();
                #[cfg(any(windows, target_os = "macos"))]
                let popup_download_attestation = popup_download_attestation.clone();
                let popup_builder = WebviewWindowBuilder::new(
                    &popup_app,
                    label.clone(),
                    WebviewUrl::External(blank),
                )
                .title(url.as_str())
                .window_features(features)
                .data_directory(popup_webview2_data_directory.clone())
                .data_store_identifier(popup_webkit_data_store_identifier)
                .initialization_script_for_all_frames(&popup_document_start_script)
                .enable_clipboard_access()
                .zoom_hotkeys_enabled(false)
                .on_navigation(|target| matches!(target.scheme(), "about" | "http" | "https"))
                .on_download(move |_webview, event| {
                    handle_browser_download(
                        &popup_download_app,
                        Some(&popup_download_role_id),
                        #[cfg(any(windows, target_os = "macos"))]
                        popup_download_attestation.as_ref(),
                        event,
                    )
                });
                #[cfg(windows)]
                let popup_builder =
                    popup_builder.additional_browser_args(&popup_additional_browser_arguments);
                let popup = popup_builder.build();
                match popup {
                    Ok(window) => {
                        if let Err(error) = install_platform_security_policy(window.as_ref()) {
                            let _ = window.close();
                            let _ = popup_app.emit(
                                "rion://shell-error",
                                json!({
                                    "code": error.code,
                                    "message": error.message,
                                    "roleId": role_id,
                                    "url": url
                                }),
                            );
                            return NewWindowResponse::Deny;
                        }
                        if let Err(error) = install_process_failure_monitor(
                            window.as_ref(),
                            popup_app.clone(),
                            role_id.clone(),
                        ) {
                            let _ = window.close();
                            let _ = popup_app.emit(
                                "rion://shell-error",
                                json!({
                                    "code": error.code,
                                    "message": error.message,
                                    "roleId": role_id,
                                    "url": url
                                }),
                            );
                            return NewWindowResponse::Deny;
                        }
                        if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                            state.runtime.register_popup(label, role_id.clone());
                        }
                        NewWindowResponse::Create { window }
                    }
                    Err(error) => {
                        let _ = popup_app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "SYSTEM_POPUP_CREATE_FAILED",
                                "message": error.to_string(),
                                "roleId": role_id,
                                "url": url
                            }),
                        );
                        NewWindowResponse::Deny
                    }
                }
            })
            .on_download(move |_webview, event| {
                handle_browser_download(
                    &download_app,
                    download_role_id.as_deref(),
                    #[cfg(any(windows, target_os = "macos"))]
                    download_attestation.as_ref(),
                    event,
                )
            });
        if role_id.is_some() {
            builder = builder.initialization_script_for_all_frames(
                &self.configuration.overlay_document_start_script,
            );
        }
        #[cfg(windows)]
        {
            builder =
                builder.additional_browser_args(&self.configuration.additional_browser_arguments);
        }
        Ok(builder)
    }

    fn clear_role_browser_data(
        &self,
        role_id: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
    ) -> RuntimeResult<()> {
        if self.state()?.role_tabs.contains_key(role_id) {
            return Err(RuntimeError::new(
                "ROLE_BROWSER_DATA_IN_USE",
                "Stop the role before clearing its System WebView data.",
            ));
        }
        let webkit_identifier = uuid::Uuid::parse_str(webkit_data_store_identifier)
            .map_err(|_| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_INVALID",
                    "The WKWebsiteDataStore identifier is invalid.",
                )
            })?
            .into_bytes();
        let paths = SessionPaths {
            webkit_identifier,
            webview2: PathBuf::from(webview2_user_data_dir),
        };
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let window = WindowBuilder::new(&self.app, runtime_label("browser-data-clear", role_id))
            .inner_size(1.0, 1.0)
            .visible(false)
            .build()
            .map_err(RuntimeError::tauri)?;
        let webview = window
            .add_child(
                self.webview_builder(
                    runtime_label("browser-data-clear-webview", role_id),
                    &paths,
                    None,
                )?,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )
            .map_err(|error| {
                let _ = window.close();
                RuntimeError::tauri(error)
            })?;
        let result = webview
            .clear_all_browsing_data()
            .map_err(RuntimeError::tauri);
        let _ = webview.close();
        let _ = window.close();
        result
    }

    fn create_compatibility_surface(
        &self,
        plan: CompatibilityCheckPlanRecord,
    ) -> RuntimeResult<()> {
        let mut state = self.state()?;
        if state.compatibility.contains_key(&plan.game_id) {
            return Err(RuntimeError::new(
                "COMPATIBILITY_RUN_ALREADY_ACTIVE",
                "A compatibility surface already exists for this game.",
            ));
        }
        let window = WindowBuilder::new(
            &self.app,
            runtime_label("compatibility-window", &plan.game_id),
        )
        .title(format!("{} compatibility", plan.game_name))
        .inner_size(960.0, 640.0)
        .visible(false)
        .build()
        .map_err(RuntimeError::tauri)?;
        let navigation = Arc::new(NavigationTracker::default());
        let callback_navigation = Arc::clone(&navigation);
        let paths =
            compatibility_session_paths(&self.user_data_dir, &plan.game_id, &plan.started_at);
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let builder = self
            .webview_builder(
                runtime_label("compatibility-webview", &plan.game_id),
                &paths,
                None,
            )?
            .incognito(true)
            .on_page_load(move |_webview, payload| {
                callback_navigation.page_event(payload.event(), payload.url());
            });
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(960.0, 640.0),
            )
            .map_err(|error| {
                let _ = window.close();
                RuntimeError::tauri(error)
            })?;
        if let Err(error) = install_platform_security_policy(&webview) {
            let _ = webview.close();
            let _ = window.close();
            return Err(error);
        }
        state.compatibility.insert(
            plan.game_id,
            CompatibilitySurface {
                data_directory: paths.webview2,
                navigation,
                webview,
                window,
            },
        );
        Ok(())
    }

    fn require_compatibility_surface(&self, game_id: &str) -> RuntimeResult<()> {
        if self.state()?.compatibility.contains_key(game_id) {
            Ok(())
        } else {
            Err(RuntimeError::new(
                "COMPATIBILITY_RUN_NOT_FOUND",
                "Compatibility surface was not found.",
            ))
        }
    }

    fn compatibility_webview(&self, game_id: &str) -> RuntimeResult<Webview> {
        self.state()?
            .compatibility
            .get(game_id)
            .map(|surface| surface.webview.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "COMPATIBILITY_RUN_NOT_FOUND",
                    "Compatibility surface was not found.",
                )
            })
    }

    fn evaluate_webview(&self, webview: &Webview, source: &str) -> RuntimeResult<String> {
        evaluate_system_webview(webview, source)
    }

    fn load_compatibility_url(&self, game_id: &str, url: &str) -> RuntimeResult<String> {
        let (webview, navigation) = {
            let state = self.state()?;
            let surface = state.compatibility.get(game_id).ok_or_else(|| {
                RuntimeError::new(
                    "COMPATIBILITY_RUN_NOT_FOUND",
                    "Compatibility surface was not found.",
                )
            })?;
            (surface.webview.clone(), Arc::clone(&surface.navigation))
        };
        navigation.reset();
        webview
            .navigate(checked_web_url(url)?)
            .map_err(RuntimeError::tauri)?;
        navigation
            .wait()
            .map_err(|message| RuntimeError::new("GAME_PAGE_LOAD_FAILED", message))?;
        webview
            .url()
            .map(|url| url.to_string())
            .map_err(RuntimeError::tauri)
    }

    fn cleanup_compatibility_surface(&self, game_id: &str) -> RuntimeResult<()> {
        let surface = self.state()?.compatibility.remove(game_id);
        if let Some(surface) = surface {
            let _ = surface.webview.clear_all_browsing_data();
            let _ = surface.webview.close();
            let close_result = surface.window.close().map_err(RuntimeError::tauri);
            if let Some(directory) = surface.data_directory.parent() {
                let _ = fs::remove_dir_all(directory);
            }
            close_result?;
        }
        Ok(())
    }

    fn resolve_runtime_layout(
        &self,
        metrics: WindowContentMetrics,
        roles: Vec<LayoutRoleInput>,
        gap: u32,
    ) -> RuntimeResult<ResolvedRuntimeLayout> {
        let descriptors = self
            .core
            .invoke(CoreCommand::LayoutCreateDividers {
                roles: roles.clone(),
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value::<Vec<WorkspaceDividerDescriptor>>(value)
                    .map_err(|error| RuntimeError::new("TAURI_LAYOUT_INVALID", error.to_string()))
            })?;
        let output = self
            .core
            .invoke(CoreCommand::LayoutResolve {
                input: WorkspaceLayoutInput {
                    active: true,
                    hidden: false,
                    window_visible: true,
                    content_bounds: LayoutBounds {
                        x: 0,
                        y: metrics.top_inset.round() as i32,
                        width: metrics.width.round().max(1.0) as i32,
                        height: metrics.height.round().max(1.0) as i32,
                    },
                    gap,
                    roles,
                    dividers: descriptors
                        .iter()
                        .map(|divider| LayoutDividerInput {
                            axis: divider.axis.clone(),
                            before_role_ids: divider.before_role_ids.clone(),
                            after_role_ids: divider.after_role_ids.clone(),
                        })
                        .collect(),
                },
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value::<WorkspaceLayoutOutput>(value)
                    .map_err(|error| RuntimeError::new("TAURI_LAYOUT_INVALID", error.to_string()))
            })?;
        let roles = output
            .roles
            .into_iter()
            .map(|role| {
                (
                    role.role_id,
                    RoleBounds {
                        x: role.bounds.x as f64,
                        y: role.bounds.y as f64,
                        width: role.bounds.width.max(1) as f64,
                        height: role.bounds.height.max(1) as f64,
                    },
                )
            })
            .collect();
        let dividers = output
            .dividers
            .into_iter()
            .filter_map(|divider| {
                descriptors
                    .get(divider.index as usize)
                    .cloned()
                    .map(|descriptor| {
                        (
                            divider.index,
                            descriptor,
                            RoleBounds {
                                x: divider.bounds.x as f64,
                                y: divider.bounds.y as f64,
                                width: divider.bounds.width.max(1) as f64,
                                height: divider.bounds.height.max(1) as f64,
                            },
                        )
                    })
            })
            .collect();
        Ok((roles, dividers))
    }

    fn layout_runtime_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let (window, role_views, divider_views, gap, tab_strip, _toolbar_revealed) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let host = state.display_hosts.get(&tab.display_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
            (
                host.window.clone(),
                tab.roles
                    .iter()
                    .map(|(role_id, surface)| {
                        (
                            role_id.clone(),
                            surface.webview.clone(),
                            LayoutRoleInput {
                                role_id: role_id.clone(),
                                rect: LayoutRect {
                                    x: surface.rect.x,
                                    y: surface.rect.y,
                                    width: surface.rect.width,
                                    height: surface.rect.height,
                                },
                            },
                        )
                    })
                    .collect::<Vec<_>>(),
                tab.dividers
                    .iter()
                    .map(|divider| (divider.index, divider.webview.clone()))
                    .collect::<HashMap<_, _>>(),
                tab.workspace_appearance.gap,
                #[cfg(windows)]
                Some(host.tab_strip.clone()),
                #[cfg(not(windows))]
                Option::<Webview>::None,
                #[cfg(windows)]
                host.toolbar_revealed,
                #[cfg(not(windows))]
                false,
            )
        };
        #[cfg(windows)]
        let tab_strip_height = self.windows_tab_strip_height(&window, _toolbar_revealed);
        #[cfg(windows)]
        let metrics = runtime_window_content_metrics_with_tab_strip(&window, tab_strip_height)?;
        #[cfg(not(windows))]
        let metrics = runtime_window_content_metrics(&window)?;
        #[cfg(windows)]
        if let Some(tab_strip) = tab_strip {
            tab_strip
                .set_position(LogicalPosition::new(0.0, 0.0))
                .map_err(RuntimeError::tauri)?;
            tab_strip
                .set_size(LogicalSize::new(metrics.width, tab_strip_height))
                .map_err(RuntimeError::tauri)?;
        }
        #[cfg(not(windows))]
        let _ = tab_strip;
        let role_inputs = role_views
            .iter()
            .map(|(_, _, input)| input.clone())
            .collect();
        let (role_bounds, divider_bounds) =
            self.resolve_runtime_layout(metrics, role_inputs, gap)?;
        for (role_id, webview, _) in role_views {
            if let Some(bounds) = role_bounds.get(&role_id) {
                webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .map_err(RuntimeError::tauri)?;
                webview
                    .set_size(LogicalSize::new(bounds.width, bounds.height))
                    .map_err(RuntimeError::tauri)?;
            }
        }
        for (index, descriptor, bounds) in divider_bounds {
            if let Some(webview) = divider_views.get(&index) {
                let bounds = divider_hit_bounds(&descriptor.axis, bounds);
                webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .map_err(RuntimeError::tauri)?;
                webview
                    .set_size(LogicalSize::new(bounds.width, bounds.height))
                    .map_err(RuntimeError::tauri)?;
            }
        }
        Ok(())
    }

    fn ensure_display_host(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        title: &str,
    ) -> RuntimeResult<(Window, bool)> {
        if let Some(window) = self
            .state()?
            .display_hosts
            .get(&target.display_id)
            .map(|host| host.window.clone())
        {
            return Ok((window, false));
        }

        // Tauri unregisters a closed native window asynchronously. A fresh generation keeps a
        // display that loses its final tab from colliding with that retiring window while still
        // preserving one stable host for the full lifetime of the next tab group.
        let host_generation = DISPLAY_HOST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let host_id = format!("{}:{host_generation}", target.display_id);
        let window_label = runtime_label("game-display", &host_id);
        let window = WindowBuilder::new(&self.app, window_label)
            .title(title)
            .position(target.work_area.x as f64, target.work_area.y as f64)
            .inner_size(
                target.work_area.width.max(1) as f64,
                target.work_area.height.max(1) as f64,
            )
            .visible(false)
            .build()
            .map_err(RuntimeError::tauri)?;
        #[cfg(target_os = "macos")]
        let tabs_controller =
            match crate::runtime_tabs_macos::MacRuntimeTabsController::create(&self.app, &window) {
                Ok(controller) => controller,
                Err(message) => {
                    let _ = window.close();
                    return Err(RuntimeError::new("MACOS_RUNTIME_TABS_FAILED", message));
                }
            };
        #[cfg(windows)]
        let tab_strip = match window.add_child(
            WebviewBuilder::new(
                runtime_label("game-tab-strip", &host_id),
                WebviewUrl::App("runtime-tabs.html".into()),
            ),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(
                target.work_area.width.max(1) as f64,
                WINDOWS_TAB_STRIP_HEIGHT,
            ),
        ) {
            Ok(tab_strip) => tab_strip,
            Err(error) => {
                let _ = window.close();
                return Err(RuntimeError::tauri(error));
            }
        };

        let mut state = self.state()?;
        if let Some(existing) = state.display_hosts.get(&target.display_id) {
            let existing = existing.window.clone();
            drop(state);
            let _ = window.close();
            return Ok((existing, false));
        }
        state.display_hosts.insert(
            target.display_id,
            RuntimeDisplayHost {
                target: target.clone(),
                window: window.clone(),
                #[cfg(windows)]
                tab_strip,
                #[cfg(windows)]
                toolbar_revealed: false,
                #[cfg(target_os = "macos")]
                tabs_controller,
            },
        );
        Ok((window, true))
    }

    fn remove_empty_display_host(&self, display_id: i64, created_for_operation: bool) {
        if !created_for_operation {
            return;
        }
        let host = self.state.lock().ok().and_then(|mut state| {
            let has_tabs = state.tabs.values().any(|tab| tab.display_id == display_id);
            if has_tabs {
                return None;
            }
            let host = state.display_hosts.remove(&display_id)?;
            state
                .allow_window_close_labels
                .insert(host.window.label().to_owned());
            Some(host)
        });
        if let Some(host) = host {
            let _ = host.window.close();
        }
    }

    fn create_tab(&self, tab: EmbeddedTabEffectRecord) -> RuntimeResult<()> {
        if tab
            .roles
            .iter()
            .any(|role| !is_current_system_engine(role.resolved_engine))
        {
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_ENGINE_MISMATCH",
                "This tab did not resolve to the current platform System WebView.",
            ));
        }
        {
            let state = self.state()?;
            if state.tabs.contains_key(&tab.tab_id) {
                return Err(RuntimeError::new(
                    "TAURI_RUNTIME_TAB_DUPLICATE",
                    "The System WebView tab already exists.",
                ));
            }
        }
        let target = tab.target.clone();
        let (window, host_created) = self.ensure_display_host(&target, &tab.name)?;
        let mut created_webviews = Vec::new();
        let result = (|| -> RuntimeResult<()> {
            let content_metrics = runtime_window_content_metrics(&window)?;
            let role_inputs = tab
                .roles
                .iter()
                .map(|role| LayoutRoleInput {
                    role_id: role.role.id.clone(),
                    rect: LayoutRect {
                        x: role.rect.x,
                        y: role.rect.y,
                        width: role.rect.width,
                        height: role.rect.height,
                    },
                })
                .collect::<Vec<_>>();
            let (resolved_role_bounds, resolved_dividers) = self.resolve_runtime_layout(
                content_metrics,
                role_inputs,
                tab.workspace_appearance.gap,
            )?;
            let mut surfaces = HashMap::new();
            let mut role_ids = Vec::with_capacity(tab.roles.len());
            for role in &tab.roles {
                let role_id = role.role.id.clone();
                let navigation = Arc::new(NavigationTracker::default());
                let callback_navigation = Arc::clone(&navigation);
                let role_label = runtime_label("game-role", &role_id);
                let paths = role_session_paths(&self.user_data_dir, &role_id)?;
                fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
                let builder = self
                    .webview_builder(role_label, &paths, Some(&role_id))?
                    .on_page_load(move |_webview, payload| {
                        callback_navigation.page_event(payload.event(), payload.url());
                    });
                let bounds = resolved_role_bounds
                    .get(&role_id)
                    .copied()
                    .unwrap_or_else(|| role_bounds_for_content(content_metrics, &role.rect));
                let webview = window
                    .add_child(
                        builder,
                        LogicalPosition::new(bounds.x, bounds.y),
                        LogicalSize::new(bounds.width, bounds.height),
                    )
                    .map_err(RuntimeError::tauri)?;
                created_webviews.push(webview.clone());
                install_platform_security_policy(&webview)
                    .and_then(|()| {
                        install_process_failure_monitor(&webview, self.app.clone(), role_id.clone())
                    })
                    .and_then(|()| {
                        webview
                            .set_zoom(role.zoom_factor)
                            .map_err(RuntimeError::tauri)
                    })?;
                webview.hide().map_err(RuntimeError::tauri)?;
                role_ids.push(role_id.clone());
                surfaces.insert(
                    role_id,
                    RoleSurface {
                        current_url: None,
                        navigation,
                        rect: role.rect.clone(),
                        webview,
                        zoom_factor: role.zoom_factor,
                    },
                );
            }
            let mut dividers = Vec::with_capacity(resolved_dividers.len());
            for (index, descriptor, bounds) in resolved_dividers {
                let bounds = divider_hit_bounds(&descriptor.axis, bounds);
                let webview = window
                    .add_child(
                        WebviewBuilder::new(
                            runtime_label("game-divider", &format!("{}:{index}", tab.tab_id)),
                            WebviewUrl::App(
                                format!("runtime-divider.html?axis={}", descriptor.axis).into(),
                            ),
                        )
                        .transparent(true),
                        LogicalPosition::new(bounds.x, bounds.y),
                        LogicalSize::new(bounds.width, bounds.height),
                    )
                    .map_err(RuntimeError::tauri)?;
                created_webviews.push(webview.clone());
                webview.hide().map_err(RuntimeError::tauri)?;
                dividers.push(RuntimeDivider {
                    descriptor,
                    index,
                    webview,
                });
            }
            wait_for_tauri_main_thread(&self.app)?;
            let tab_id = tab.tab_id;
            let mut state = self.state()?;
            if state.tabs.contains_key(&tab_id) {
                drop(state);
                return Err(RuntimeError::new(
                    "TAURI_RUNTIME_TAB_DUPLICATE",
                    "The System WebView tab was created concurrently.",
                ));
            }
            for role_id in role_ids {
                state.role_tabs.insert(role_id, tab_id.clone());
            }
            state.tabs.insert(
                tab_id,
                RuntimeTab {
                    active_divider_resize: None,
                    audio_muted: false,
                    dividers,
                    display_id: target.display_id,
                    roles: surfaces,
                    workspace_appearance: tab.workspace_appearance,
                    workspace_template: tab.workspace_template,
                },
            );
            Ok(())
        })();
        if result.is_err() {
            for webview in created_webviews {
                let _ = webview.close();
            }
            self.remove_empty_display_host(target.display_id, host_created);
        }
        result
    }

    fn load_roles(&self, roles: Vec<EmbeddedRoleLoadEffectRecord>) -> RuntimeResult<()> {
        for role in roles {
            if !is_current_system_engine(role.resolved_engine) {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_ENGINE_MISMATCH",
                    "The role did not resolve to the current platform System WebView.",
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
            let url = checked_web_url(&role.url)?;
            let restore_attestation =
                std::env::var_os("RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_OUTPUT").is_some();
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
                role_surface.zoom_factor = role.zoom_factor;
            }
            navigation.reset();
            if restore_attestation {
                eprintln!(
                    "Runtime restore attestation: navigating {} to {url}.",
                    role.role_id
                );
            }
            surface.navigate(url.clone()).map_err(RuntimeError::tauri)?;
            if restore_attestation {
                eprintln!(
                    "Runtime restore attestation: navigation scheduled for {}.",
                    role.role_id
                );
            }
            surface
                .set_zoom(role.zoom_factor)
                .map_err(RuntimeError::tauri)?;
            navigation
                .wait()
                .map_err(|message| RuntimeError::new("TAURI_NAVIGATION_FAILED", message))?;
            if restore_attestation {
                eprintln!(
                    "Runtime restore attestation: navigation finished for {}.",
                    role.role_id
                );
            }
            self.reassert_role_keys(&role.role_id, &surface)?;
        }
        Ok(())
    }

    fn install_overlays(&self, role_ids: &[String]) -> RuntimeResult<()> {
        for role_id in role_ids {
            let webview = self.role_webview(role_id)?;
            webview
                .eval(&self.configuration.overlay_document_start_script)
                .map_err(RuntimeError::tauri)?;
            let ready = self.evaluate_webview(
                &webview,
                "typeof globalThis.rionStudioMacroOverlay === 'function' && typeof globalThis.__rionStudioMacroOverlay === 'object'",
            )?;
            if !matches!(serde_json::from_str::<bool>(&ready), Ok(true)) {
                return Err(RuntimeError::new(
                    "SYSTEM_OVERLAY_BRIDGE_UNAVAILABLE",
                    "The System WebView overlay bridge is unavailable.",
                ));
            }
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
            let window = state
                .display_hosts
                .get(&tab.display_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "Runtime display host was not found.",
                    )
                })?;
            (window, role.webview.clone())
        };
        if let Some(zoom_factor) = zoom_factor {
            webview.set_zoom(zoom_factor).map_err(RuntimeError::tauri)?;
            if let Ok(mut state) = self.state()
                && let Some(tab_id) = state.role_tabs.get(role_id).cloned()
                && let Some(role_surface) = state
                    .tabs
                    .get_mut(&tab_id)
                    .and_then(|tab| tab.roles.get_mut(role_id))
            {
                role_surface.zoom_factor = zoom_factor;
            }
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
        let trace_restore =
            std::env::var_os("RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_OUTPUT").is_some();
        let trace = |step: &str| {
            if trace_restore {
                eprintln!("Runtime restore attestation: apply runtime {step}.");
            }
        };
        struct TabUpdate {
            active: bool,
            display_id: i64,
            focus: bool,
            moved: bool,
            source_display_id: i64,
            surfaces: Vec<Webview>,
            tab_id: String,
        }
        struct HostUpdate {
            active_webview: Option<Webview>,
            focus: bool,
            title: Option<String>,
            visible: bool,
            window: Window,
        }

        let ensured_target_host = if let Some(target) = target.as_ref() {
            let title = snapshot
                .displays
                .iter()
                .find(|display| display.display_id == target.display_id)
                .and_then(|display| display.active_tab_id.as_deref())
                .and_then(|tab_id| snapshot.tabs.iter().find(|tab| tab.id == tab_id))
                .map(|tab| tab.name.as_str())
                .unwrap_or("Rion Studio");
            let (_, created) = self.ensure_display_host(target, title)?;
            Some((target.display_id, created))
        } else {
            None
        };

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
        let desired_displays = snapshot
            .tabs
            .iter()
            .map(|tab| (tab.id.as_str(), tab.display_id))
            .collect::<HashMap<_, _>>();
        let live_displays = self
            .state()?
            .tabs
            .iter()
            .map(|(tab_id, tab)| (tab_id.clone(), tab.display_id))
            .collect::<HashMap<_, _>>();
        let host_plan = resolve_runtime_tab_host_plan(
            &snapshot,
            &live_displays,
            focus_window_display_ids,
            focus_tab_id,
        );
        let tab_updates = {
            let state = self.state()?;
            host_plan
                .iter()
                .filter_map(|plan| {
                    let runtime_tab = state.tabs.get(&plan.tab_id)?;
                    let mut surfaces = runtime_tab
                        .roles
                        .values()
                        .map(|role| role.webview.clone())
                        .collect::<Vec<_>>();
                    surfaces.extend(
                        runtime_tab
                            .dividers
                            .iter()
                            .map(|divider| divider.webview.clone()),
                    );
                    Some(TabUpdate {
                        active: plan.active,
                        display_id: plan.display_id,
                        focus: plan.focus,
                        moved: plan.moved,
                        source_display_id: runtime_tab.display_id,
                        surfaces,
                        tab_id: plan.tab_id.clone(),
                    })
                })
                .collect::<Vec<_>>()
        };

        trace("tab updates resolved");
        let mut reparented_surfaces = Vec::<(Webview, Window)>::new();
        for update in &tab_updates {
            if update.moved {
                let window = self.window_for_display(update.display_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "The target runtime display host was not found.",
                    )
                })?;
                let source_window = self
                    .window_for_display(update.source_display_id)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                            "The source runtime display host was not found.",
                        )
                    })?;
                for surface in &update.surfaces {
                    if let Err(error) = surface.hide() {
                        for (moved_surface, original_window) in reparented_surfaces.iter().rev() {
                            let _ = moved_surface.reparent(original_window);
                        }
                        if let Some((display_id, created)) = ensured_target_host {
                            self.remove_empty_display_host(display_id, created);
                        }
                        return Err(RuntimeError::tauri(error));
                    }
                    if let Err(error) = surface.reparent(&window) {
                        for (moved_surface, original_window) in reparented_surfaces.iter().rev() {
                            let _ = moved_surface.reparent(original_window);
                        }
                        if let Some((display_id, created)) = ensured_target_host {
                            self.remove_empty_display_host(display_id, created);
                        }
                        return Err(RuntimeError::tauri(error));
                    }
                    reparented_surfaces.push((surface.clone(), source_window.clone()));
                }
            }
        }

        trace("updating runtime state");
        let obsolete_display_ids = {
            let mut state = self.state()?;
            if let Some(target) = target.as_ref()
                && let Some(host) = state.display_hosts.get_mut(&target.display_id)
            {
                host.target = target.clone();
            }
            for update in &tab_updates {
                if let Some(runtime_tab) = state.tabs.get_mut(&update.tab_id) {
                    runtime_tab.display_id = update.display_id;
                }
            }
            state
                .display_hosts
                .keys()
                .copied()
                .filter(|display_id| {
                    !desired_displays
                        .values()
                        .any(|desired| desired == display_id)
                })
                .collect::<Vec<_>>()
        };

        if let Some(target) = target.as_ref()
            && let Some(window) = self.window_for_display(target.display_id)
        {
            trace("setting display host position");
            window
                .set_position(LogicalPosition::new(
                    target.work_area.x as f64,
                    target.work_area.y as f64,
                ))
                .map_err(RuntimeError::tauri)?;
            trace("setting display host size");
            window
                .set_size(LogicalSize::new(
                    target.work_area.width.max(1) as f64,
                    target.work_area.height.max(1) as f64,
                ))
                .map_err(RuntimeError::tauri)?;
        }

        for update in &tab_updates {
            if update.moved
                || target
                    .as_ref()
                    .is_some_and(|target| target.display_id == update.display_id)
            {
                self.layout_runtime_tab(&update.tab_id)?;
            }
            for surface in &update.surfaces {
                if update.active {
                    surface.show().map_err(RuntimeError::tauri)?;
                } else {
                    surface.hide().map_err(RuntimeError::tauri)?;
                }
            }
        }

        let host_updates = {
            let state = self.state()?;
            state
                .display_hosts
                .values()
                .map(|host| {
                    let display_id = host.target.display_id;
                    let active_tab = active_tabs.get(&display_id).copied();
                    let active_webview = active_tab.and_then(|tab_id| {
                        state
                            .tabs
                            .get(tab_id)
                            .and_then(|tab| tab.roles.values().next())
                            .map(|surface| surface.webview.clone())
                    });
                    let title = active_tab.and_then(|tab_id| {
                        snapshot
                            .tabs
                            .iter()
                            .find(|tab| tab.id == tab_id)
                            .map(|tab| tab.name.clone())
                    });
                    let has_visible_active = active_tab.is_some_and(|tab_id| {
                        snapshot
                            .tabs
                            .iter()
                            .any(|tab| tab.id == tab_id && !tab.hidden)
                    });
                    HostUpdate {
                        active_webview,
                        focus: focus_window_display_ids.contains(&display_id)
                            || tab_updates
                                .iter()
                                .any(|update| update.display_id == display_id && update.focus),
                        title,
                        visible: has_visible_active
                            && (reveal_display_ids.is_empty()
                                || reveal_display_ids.contains(&display_id)),
                        window: host.window.clone(),
                    }
                })
                .collect::<Vec<_>>()
        };
        for update in host_updates {
            if let Some(title) = update.title {
                let _ = update.window.set_title(&title);
            }
            let currently_visible = update.window.is_visible().unwrap_or(false);
            if update.visible && !currently_visible {
                trace("showing display host");
                update.window.show().map_err(RuntimeError::tauri)?;
            } else if !update.visible && currently_visible {
                trace("hiding display host");
                update.window.hide().map_err(RuntimeError::tauri)?;
            }
            if update.focus {
                trace("focusing display host");
                update.window.set_focus().map_err(RuntimeError::tauri)?;
                if let Some(webview) = update.active_webview {
                    webview.set_focus().map_err(RuntimeError::tauri)?;
                }
            }
        }
        let obsolete_hosts = {
            let mut state = self.state()?;
            obsolete_display_ids
                .into_iter()
                .filter_map(|display_id| {
                    let host = state.display_hosts.remove(&display_id)?;
                    state
                        .allow_window_close_labels
                        .insert(host.window.label().to_owned());
                    Some(host)
                })
                .collect::<Vec<_>>()
        };
        for host in obsolete_hosts {
            let _ = host.window.close();
        }
        trace("completed");
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn sync_native_tab_strip(&self, snapshot: &BrowserRuntimeSnapshot) {
        let always_show = crate::runtime_tabs_macos::fullscreen_preference(&self.core);
        let language = self
            .language
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "en".to_owned());
        let roles = self
            .core
            .invoke(CoreCommand::RolesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateRoleRecord>>(value).ok())
            .unwrap_or_default();
        let role_names = roles
            .iter()
            .map(|role| (role.id.as_str(), role.name.as_str()))
            .collect::<HashMap<_, _>>();
        let games = self
            .core
            .invoke(CoreCommand::GamesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateGameRecord>>(value).ok())
            .unwrap_or_default();
        let game_icons = games
            .iter()
            .filter_map(|game| {
                game.icon_image_data_url
                    .as_ref()
                    .map(|icon| (game.id.as_str(), icon.as_str()))
            })
            .collect::<HashMap<_, _>>();
        let role_games = roles
            .iter()
            .map(|role| (role.id.as_str(), role.game_id.as_str()))
            .collect::<HashMap<_, _>>();
        let Ok(state) = self.state.lock() else {
            return;
        };
        let updates = state
            .display_hosts
            .values()
            .map(|host| {
                let display_id = host.target.display_id;
                let active_id = snapshot
                    .displays
                    .iter()
                    .find(|display| display.display_id == display_id)
                    .and_then(|display| display.active_tab_id.as_deref());
                let tabs = snapshot
                    .tabs
                    .iter()
                    .filter(|tab| tab.display_id == display_id && !tab.hidden)
                    .filter_map(|tab| {
                        let live = state.tabs.get(&tab.id)?;
                        let names = tab
                            .role_ids
                            .iter()
                            .filter_map(|role_id| role_names.get(role_id.as_str()).copied())
                            .collect::<Vec<_>>();
                        let tooltip = if tab.tab_type == "workspace" && !names.is_empty() {
                            let separator = if matches!(language.as_str(), "zh-TW" | "zh-CN") {
                                "："
                            } else {
                                ":"
                            };
                            format!("{}{separator}{}", tab.name, names.join(", "))
                        } else {
                            tab.name.clone()
                        };
                        let icon_data_url = tab.role_ids.first().and_then(|role_id| {
                            role_games
                                .get(role_id.as_str())
                                .and_then(|game_id| game_icons.get(*game_id))
                                .map(|value| (*value).to_owned())
                        });
                        Some(crate::runtime_tabs_macos::MacRuntimeTabState {
                            active: active_id == Some(tab.id.as_str()),
                            audio_muted: live.audio_muted,
                            audible: runtime_tab_is_audible(&state, live),
                            icon_data_url,
                            id: tab.id.clone(),
                            name: tab.name.clone(),
                            tooltip,
                            tab_type: tab.tab_type.clone(),
                            workspace_template: live.workspace_template.clone(),
                        })
                    })
                    .collect::<Vec<_>>();
                (host.tabs_controller.clone(), display_id, tabs)
            })
            .collect::<Vec<_>>();
        drop(state);
        for (controller, display_id, tabs) in updates {
            let _ = controller.update(display_id, tabs, always_show, &language);
        }
    }

    #[cfg(windows)]
    fn sync_windows_tab_strip(&self, snapshot: &BrowserRuntimeSnapshot) {
        let projection = self.projection(snapshot);
        let language = self
            .language
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "en".to_owned());
        let always_show = self
            .core
            .invoke(CoreCommand::RuntimeWindowPreferencesGet)
            .ok()
            .and_then(|value| value["alwaysShowToolbarInFullScreen"].as_bool())
            .unwrap_or(false);
        let roles = self
            .core
            .invoke(CoreCommand::RolesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateRoleRecord>>(value).ok())
            .unwrap_or_default();
        let games = self
            .core
            .invoke(CoreCommand::GamesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateGameRecord>>(value).ok())
            .unwrap_or_default();
        let icons = roles
            .iter()
            .filter_map(|role| {
                games
                    .iter()
                    .find(|game| game.id == role.game_id)
                    .and_then(|game| game.icon_image_data_url.clone())
                    .map(|icon| (role.id.as_str(), icon))
            })
            .collect::<HashMap<_, _>>();
        let displays = self
            .app
            .get_webview_window("main")
            .and_then(|window| crate::workspace_displays(&window).ok())
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let updates = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .display_hosts
                    .values()
                    .map(|host| {
                        let tab_icons = snapshot
                            .tabs
                            .iter()
                            .filter_map(|snapshot_tab| {
                                snapshot_tab
                                    .role_ids
                                    .first()
                                    .and_then(|role_id| icons.get(role_id.as_str()))
                                    .map(|icon| (snapshot_tab.id.clone(), icon.clone()))
                            })
                            .collect::<serde_json::Map<_, _>>();
                        let templates = snapshot
                            .tabs
                            .iter()
                            .filter_map(|snapshot_tab| {
                                state.tabs.get(&snapshot_tab.id).and_then(|live| {
                                    live.workspace_template.as_ref().map(|template| {
                                        (snapshot_tab.id.clone(), Value::String(template.clone()))
                                    })
                                })
                            })
                            .collect::<serde_json::Map<_, _>>();
                        let fullscreen = host.window.is_fullscreen().unwrap_or(false);
                        let mut tab_strip_state = projection.clone();
                        if let Some(object) = tab_strip_state.as_object_mut() {
                            object.insert(
                                "alwaysShowToolbarInFullScreen".to_owned(),
                                json!(always_show),
                            );
                            object.insert("displayId".to_owned(), json!(host.target.display_id));
                            object.insert("displays".to_owned(), displays.clone());
                            object.insert("fullscreen".to_owned(), json!(fullscreen));
                            object.insert("language".to_owned(), json!(language));
                            object.insert("tabIconDataUrls".to_owned(), Value::Object(tab_icons));
                            object.insert(
                                "tabWorkspaceTemplates".to_owned(),
                                Value::Object(templates),
                            );
                            object.insert(
                                "toolbarVisible".to_owned(),
                                json!(!fullscreen || always_show || host.toolbar_revealed),
                            );
                            object.insert("windowFullscreen".to_owned(), json!(fullscreen));
                        }
                        (host.tab_strip.clone(), tab_strip_state)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (webview, tab_strip_state) in updates {
            let _ = webview.eval(format!(
                "window.__rionApplyRuntimeTabState?.({tab_strip_state});"
            ));
        }
    }

    #[cfg(windows)]
    fn windows_tab_strip_height(&self, window: &Window, toolbar_revealed: bool) -> f64 {
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let always_show = self
            .core
            .invoke(CoreCommand::RuntimeWindowPreferencesGet)
            .ok()
            .and_then(|value| value["alwaysShowToolbarInFullScreen"].as_bool())
            .unwrap_or(false);
        if fullscreen && !always_show && !toolbar_revealed {
            2.0
        } else {
            WINDOWS_TAB_STRIP_HEIGHT
        }
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
        let popup_labels = state
            .popup_roles
            .iter()
            .filter(|(_, popup_role_id)| popup_role_id.as_str() == role_id)
            .map(|(label, _)| label.clone())
            .collect::<Vec<_>>();
        popup_labels.iter().for_each(|label| {
            state.popup_roles.remove(label);
            state.audible_webviews.remove(label);
        });
        state.audible_webviews.remove(role.webview.label());
        drop(state);
        self.clear_role_keys(role_id);
        role.webview.close().map_err(RuntimeError::tauri)?;
        for label in popup_labels {
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.close();
            }
        }
        Ok(())
    }

    fn destroy_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let mut state = self.state()?;
        let tab = state.tabs.remove(tab_id).ok_or_else(|| {
            RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
        })?;
        for role_id in tab.roles.keys() {
            state.role_tabs.remove(role_id);
        }
        let tab_role_ids = tab.roles.keys().cloned().collect::<HashSet<_>>();
        let popup_labels = state
            .popup_roles
            .iter()
            .filter(|(_, role_id)| tab_role_ids.contains(*role_id))
            .map(|(label, _)| label.clone())
            .collect::<Vec<_>>();
        popup_labels.iter().for_each(|label| {
            state.popup_roles.remove(label);
            state.audible_webviews.remove(label);
        });
        for surface in tab.roles.values() {
            state.audible_webviews.remove(surface.webview.label());
        }
        let host = if state
            .tabs
            .values()
            .any(|candidate| candidate.display_id == tab.display_id)
        {
            None
        } else {
            let host = state.display_hosts.remove(&tab.display_id);
            if let Some(host) = host.as_ref() {
                let window_label = host.window.label().to_owned();
                state.pending_window_close_labels.remove(&window_label);
                state.allow_window_close_labels.insert(window_label);
            }
            host
        };
        drop(state);
        for role_id in tab.roles.keys() {
            self.clear_role_keys(role_id);
        }
        for surface in tab.roles.values() {
            let _ = surface.webview.close();
        }
        for divider in &tab.dividers {
            let _ = divider.webview.close();
        }
        if let Some(host) = host {
            host.window.close().map_err(RuntimeError::tauri)?;
        }
        for label in popup_labels {
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.close();
            }
        }
        Ok(())
    }

    fn show_tab(&self, tab_id: &str, focus: bool) -> RuntimeResult<()> {
        let (window, updates, active_webview) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let display_id = tab.display_id;
            let host = state.display_hosts.get(&display_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
            let updates = state
                .tabs
                .iter()
                .filter(|(_, candidate)| candidate.display_id == display_id)
                .map(|(candidate_id, candidate)| {
                    let mut surfaces = candidate
                        .roles
                        .values()
                        .map(|role| role.webview.clone())
                        .collect::<Vec<_>>();
                    surfaces.extend(
                        candidate
                            .dividers
                            .iter()
                            .map(|divider| divider.webview.clone()),
                    );
                    (candidate_id == tab_id, surfaces)
                })
                .collect::<Vec<_>>();
            (
                host.window.clone(),
                updates,
                tab.roles.values().next().map(|role| role.webview.clone()),
            )
        };
        for (visible, surfaces) in updates {
            for surface in surfaces {
                if visible {
                    surface.show().map_err(RuntimeError::tauri)?;
                } else {
                    surface.hide().map_err(RuntimeError::tauri)?;
                }
            }
        }
        if !window.is_visible().unwrap_or(false) {
            window.show().map_err(RuntimeError::tauri)?;
        }
        if focus {
            window.set_focus().map_err(RuntimeError::tauri)?;
            if let Some(webview) = active_webview {
                webview.set_focus().map_err(RuntimeError::tauri)?;
            }
        }
        Ok(())
    }

    fn set_role_audio_muted(&self, role_id: &str, muted: bool) -> RuntimeResult<()> {
        let (tab_id, webviews, popup_labels) = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            let tab = state.tabs.get(&tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let tab_role_ids = tab.roles.keys().cloned().collect::<HashSet<_>>();
            let webviews = tab
                .roles
                .values()
                .map(|role| role.webview.clone())
                .collect::<Vec<_>>();
            let popup_labels = state
                .popup_roles
                .iter()
                .filter(|(_, popup_role_id)| tab_role_ids.contains(*popup_role_id))
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            (tab_id, webviews, popup_labels)
        };
        for webview in webviews {
            set_audio_muted(&webview, muted)?;
        }
        for label in popup_labels {
            if let Some(webview) = self.app.get_webview(&label) {
                let _ = set_audio_muted(&webview, muted);
            }
        }
        if let Some(tab) = self.state()?.tabs.get_mut(&tab_id) {
            tab.audio_muted = muted;
        }
        Ok(())
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

#[cfg(any(windows, target_os = "macos"))]
fn handle_browser_download(
    app: &AppHandle,
    role_id: Option<&str>,
    attestation: Option<&Arc<DownloadAttestationTracker>>,
    event: DownloadEvent<'_>,
) -> bool {
    let payload = match event {
        DownloadEvent::Requested { url, destination } => {
            if let Some(attestation) = attestation {
                attestation.requested(&url, destination);
            }
            json!({
                "state": "started",
                "roleId": role_id,
                "url": url,
                "path": destination.to_string_lossy()
            })
        }
        DownloadEvent::Finished { url, path, success } => {
            if let Some(attestation) = attestation {
                attestation.finished(success);
            }
            json!({
                "state": if success { "completed" } else { "failed" },
                "roleId": role_id,
                "url": url,
                "path": path.map(|path| path.to_string_lossy().into_owned())
            })
        }
        _ => return true,
    };
    let _ = app.emit("rion://browser-download", payload);
    true
}

#[cfg(not(any(windows, target_os = "macos")))]
fn handle_browser_download(
    app: &AppHandle,
    role_id: Option<&str>,
    event: DownloadEvent<'_>,
) -> bool {
    let payload = match event {
        DownloadEvent::Requested { url, destination } => json!({
            "state": "started",
            "roleId": role_id,
            "url": url,
            "path": destination.to_string_lossy()
        }),
        DownloadEvent::Finished { url, path, success } => json!({
            "state": if success { "completed" } else { "failed" },
            "roleId": role_id,
            "url": url,
            "path": path.map(|path| path.to_string_lossy().into_owned())
        }),
        _ => return true,
    };
    let _ = app.emit("rion://browser-download", payload);
    true
}

fn evaluate_system_webview(webview: &Webview, source: &str) -> RuntimeResult<String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .eval_with_callback(source, move |value| {
            let _ = sender.send(value);
        })
        .map_err(RuntimeError::tauri)?;
    receiver.recv_timeout(Duration::from_secs(30)).map_err(|_| {
        RuntimeError::new(
            "TAURI_EVALUATION_TIMEOUT",
            "System WebView JavaScript evaluation timed out.",
        )
    })
}

fn wait_for_tauri_main_thread(app: &AppHandle) -> RuntimeResult<()> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(());
    })
    .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "TAURI_MAIN_THREAD_TIMEOUT",
                "The Tauri main thread did not finish creating the System WebView.",
            )
        })
}

#[cfg(any(windows, target_os = "macos"))]
pub fn start_trusted_input_attestation(
    app: AppHandle,
    output_path: PathBuf,
    runtime: Arc<SystemRuntimeExecutor>,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    let data_directory = output_path
        .parent()
        .ok_or_else(|| "Trusted-input attestation output has no parent directory.".to_owned())?
        .join("system-webview-data");
    fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    let window = WindowBuilder::new(&app, "system-input-attestation-window")
        .title("Rion Studio System Input Attestation")
        .inner_size(320.0, 240.0)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    eprintln!("System WebView parity: attestation host window created.");
    let (page_sender, page_receiver) = std::sync::mpsc::sync_channel(1);
    let builder = WebviewBuilder::new(
        "system-input-attestation-webview",
        WebviewUrl::App("index.html".into()),
    )
    .data_directory(data_directory)
    .data_store_identifier([
        0x52, 0x69, 0x6f, 0x6e, 0x80, 0x00, 0x40, 0x01, 0x80, 0x00, 0x54, 0x72, 0x75, 0x73, 0x74,
        0x01,
    ])
    .initialization_script_for_all_frames(TRUSTED_INPUT_ATTESTATION_SOURCE)
    .on_page_load(move |_webview, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let _ = page_sender.try_send(());
        }
    });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(320.0, 240.0),
        )
        .map_err(|error| {
            let _ = window.close();
            error.to_string()
        })?;
    eprintln!("System WebView parity: attestation child WebView created.");
    if let Err(error) = install_platform_security_policy(&webview) {
        let _ = webview.close();
        let _ = window.close();
        return Err(error.message);
    }
    std::thread::Builder::new()
        .name("rion-system-input-attestation".to_owned())
        .spawn(move || {
            eprintln!("System WebView parity: trusted-input worker started.");
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_trusted_input_attestation(&webview, page_receiver).and_then(|mut report| {
                    report["registration"] =
                        serde_json::to_value(runtime.registration()).map_err(|error| {
                            RuntimeError::new("SYSTEM_INPUT_ATTESTATION_INVALID", error.to_string())
                        })?;
                    report["roleParity"] = run_role_count_attestation(&runtime)?;
                    Ok(report)
                })
            }))
            .unwrap_or_else(|_| {
                Err(input_attestation_error(
                    "The trusted-input attestation worker panicked.",
                ))
            });
            let (document, exit_code) = match outcome {
                Ok(report) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": true,
                        "platform": if cfg!(windows) { "windows" } else { "macos" },
                        "engine": if cfg!(windows) { "webview2" } else { "wkwebview" },
                        "report": report
                    }),
                    0,
                ),
                Err(error) => (
                    json!({
                        "schemaVersion": 1,
                        "ok": false,
                        "platform": if cfg!(windows) { "windows" } else { "macos" },
                        "engine": if cfg!(windows) { "webview2" } else { "wkwebview" },
                        "error": { "code": error.code, "message": error.message }
                    }),
                    7,
                ),
            };
            let write_result = write_attestation_result(&output_path, &document);
            let _ = webview.close();
            let _ = window.close();
            if let Err(error) = write_result {
                eprintln!("Trusted-input attestation output failed: {error}");
                app.exit(8);
            } else {
                app.exit(exit_code);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
fn run_trusted_input_attestation(
    webview: &Webview,
    page_receiver: std::sync::mpsc::Receiver<()>,
) -> RuntimeResult<Value> {
    page_receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_INPUT_ATTESTATION_TIMEOUT",
                "The System WebView input fixture page did not finish loading.",
            )
        })?;
    webview
        .eval(TRUSTED_INPUT_ATTESTATION_SOURCE)
        .map_err(RuntimeError::tauri)?;
    let ready_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(value) = evaluate_attestation_value(
            webview,
            "globalThis.__rionInputAttestation?.snapshot instanceof Function",
        ) && value == Value::Bool(true)
        {
            break;
        }
        if Instant::now() >= ready_deadline {
            return Err(RuntimeError::new(
                "SYSTEM_INPUT_ATTESTATION_TIMEOUT",
                "The System WebView input fixture did not become ready.",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    attest_key(webview, "rawKeyDown", "KeyA", &[], false)?;
    let held = attestation_snapshot(webview)?;
    require_attestation_field(&held, "keyDown", json!(1))?;
    require_attestation_field(&held, "keyUp", json!(0))?;
    require_attestation_field(&held, "heldCount", json!(1))?;
    attest_key(webview, "keyUp", "KeyA", &[], false)?;

    attest_key(webview, "rawKeyDown", "ShiftLeft", &["ShiftLeft"], false)?;
    attest_key(webview, "rawKeyDown", "KeyA", &["ShiftLeft", "KeyA"], false)?;
    attest_key(webview, "rawKeyDown", "KeyA", &["ShiftLeft", "KeyA"], true)?;
    attest_key(webview, "keyUp", "KeyA", &["ShiftLeft"], false)?;
    attest_key(webview, "keyUp", "ShiftLeft", &[], false)?;
    dispatch_mouse_effect(webview, ClickPoint { x: 32, y: 32 }, "left", true)?;
    std::thread::sleep(Duration::from_millis(2));
    dispatch_mouse_effect(webview, ClickPoint { x: 32, y: 32 }, "left", false)?;
    std::thread::sleep(Duration::from_millis(2));
    let behavior = attestation_snapshot(webview)?;
    require_attestation_field(&behavior, "allTrusted", json!(true))?;
    require_attestation_field(&behavior, "backgroundOnly", json!(true))?;
    require_attestation_field(&behavior, "documentFocused", json!(false))?;
    require_attestation_field(&behavior, "heldCount", json!(0))?;
    require_attestation_field(&behavior, "keyDown", json!(4))?;
    require_attestation_field(&behavior, "keyUp", json!(3))?;
    require_attestation_field(&behavior, "modifierObserved", json!(true))?;
    require_attestation_field(&behavior, "mouseDown", json!(1))?;
    require_attestation_field(&behavior, "mouseUp", json!(1))?;
    require_attestation_field(&behavior, "repeatCount", json!(1))?;
    let codes = behavior
        .get("codes")
        .and_then(Value::as_array)
        .ok_or_else(|| input_attestation_error("The input fixture did not record key codes."))?;
    if !codes.iter().any(|code| code == "KeyA") || !codes.iter().any(|code| code == "ShiftLeft") {
        return Err(input_attestation_error(
            "The input fixture did not receive KeyA and ShiftLeft.",
        ));
    }

    let reset = evaluate_attestation_value(webview, "__rionInputAttestation.reset()")?;
    if reset != Value::Bool(true) {
        return Err(input_attestation_error(
            "The input fixture could not reset before the soak.",
        ));
    }
    const CYCLES: u64 = 1_000;
    for _ in 0..CYCLES {
        attest_key(webview, "rawKeyDown", "KeyA", &["KeyA"], false)?;
        attest_key(webview, "keyUp", "KeyA", &[], false)?;
    }
    let stress = attestation_snapshot(webview)?;
    require_attestation_field(&stress, "allTrusted", json!(true))?;
    require_attestation_field(&stress, "backgroundOnly", json!(true))?;
    require_attestation_field(&stress, "documentFocused", json!(false))?;
    require_attestation_field(&stress, "heldCount", json!(0))?;
    require_attestation_field(&stress, "keyDown", json!(CYCLES))?;
    require_attestation_field(&stress, "keyUp", json!(CYCLES))?;
    Ok(json!({
        "behavior": behavior,
        "stress": stress,
        "cycles": CYCLES
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn run_role_count_attestation(runtime: &Arc<SystemRuntimeExecutor>) -> RuntimeResult<Value> {
    let server = AttestationServer::start()?;
    let mut layouts = Vec::new();
    let mut popup_download = None;
    let mut recovery = None;
    let mut total_roles = 0_u64;
    for count in [1_usize, 3, 6, 9] {
        eprintln!("System WebView parity: creating {count}-role layout.");
        let tab_id = format!("attestation-tab-{count}");
        let roles = (0..count)
            .map(|index| attestation_role(count, index))
            .collect::<Vec<_>>();
        runtime.create_tab(EmbeddedTabEffectRecord {
            tab_id: tab_id.clone(),
            source_id: format!("attestation-workspace-{count}"),
            name: format!("System WebView {count}-role attestation"),
            workspace_id: Some(format!("attestation-workspace-{count}")),
            workspace_template: Some(
                match count {
                    1 => "single",
                    3 => "three_columns",
                    6 => "six_grid",
                    _ => "nine_grid",
                }
                .to_owned(),
            ),
            workspace_appearance: WorkspaceAppearanceSettingsRecord {
                background: "black".to_owned(),
                gap: 2,
            },
            target: EmbeddedLaunchTargetRecord {
                display_id: -9_999,
                work_area: rion_core::StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 960,
                    height: 640,
                },
            },
            roles,
        })?;
        eprintln!("System WebView parity: verifying {count}-role layout.");
        let verification = verify_attestation_tab(runtime, &server, &tab_id, count);
        let edge_verification = if verification.is_ok() && count == 1 {
            verify_popup_download_attestation(runtime)
        } else {
            Ok(None)
        };
        let recovery_verification =
            if verification.is_ok() && edge_verification.is_ok() && count == 1 {
                verify_surface_recovery_attestation(runtime)
            } else {
                Ok(None)
            };
        eprintln!("System WebView parity: destroying {count}-role layout.");
        let cleanup = runtime.destroy_tab(&tab_id);
        verification?;
        if let Some(report) = edge_verification? {
            popup_download = Some(report);
        }
        if let Some(report) = recovery_verification? {
            recovery = Some(report);
        }
        cleanup?;
        let state = runtime.state()?;
        if state.tabs.contains_key(&tab_id)
            || state.display_hosts.contains_key(&-9_999)
            || state
                .role_tabs
                .keys()
                .any(|role_id| role_id.starts_with(&format!("attestation-{count}-")))
        {
            return Err(input_attestation_error(format!(
                "The {count}-role System WebView layout did not fully release its native handles."
            )));
        }
        drop(state);
        total_roles += count as u64;
        eprintln!("System WebView parity: completed {count}-role layout.");
        layouts.push(json!({
            "count": count,
            "loaded": true,
            "pixelParity": true,
            "released": true
        }));
    }
    let create_destroy_cycles = run_create_destroy_attestation(runtime)?;
    let shared_display_host = verify_shared_display_host_attestation(runtime, &server)?;
    drop(server);
    Ok(json!({
        "counts": [1, 3, 6, 9],
        "createDestroyCycles": create_destroy_cycles,
        "sharedDisplayHost": shared_display_host,
        "layouts": layouts,
        "popupDownload": popup_download,
        "recovery": recovery,
        "totalRoles": total_roles
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn verify_shared_display_host_attestation(
    runtime: &SystemRuntimeExecutor,
    server: &AttestationServer,
) -> RuntimeResult<Value> {
    const DISPLAY_ID: i64 = -9_998;
    let target = EmbeddedLaunchTargetRecord {
        display_id: DISPLAY_ID,
        work_area: rion_core::StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 640,
            height: 480,
        },
    };
    let make_tab = |tab_id: &str, role_id: &str| {
        let mut role = attestation_role(1, 0);
        role.role.id = role_id.to_owned();
        role.role.name = role_id.to_owned();
        EmbeddedTabEffectRecord {
            tab_id: tab_id.to_owned(),
            source_id: role_id.to_owned(),
            name: tab_id.to_owned(),
            workspace_id: None,
            workspace_template: None,
            workspace_appearance: WorkspaceAppearanceSettingsRecord {
                background: "black".to_owned(),
                gap: 2,
            },
            target: target.clone(),
            roles: vec![role],
        }
    };
    let first_tab_id = "attestation-shared-tab-a";
    let second_tab_id = "attestation-shared-tab-b";
    runtime.create_tab(make_tab(first_tab_id, "attestation-shared-role-a"))?;
    if let Err(error) = runtime.create_tab(make_tab(second_tab_id, "attestation-shared-role-b")) {
        let _ = runtime.destroy_tab(first_tab_id);
        return Err(error);
    }
    let result = (|| -> RuntimeResult<Value> {
        let snapshot = |active_tab_id: &str| -> RuntimeResult<BrowserRuntimeSnapshot> {
            serde_json::from_value(json!({
                "displays": [{
                    "displayId": DISPLAY_ID,
                    "activeTabId": active_tab_id,
                    "tabIds": [first_tab_id, second_tab_id]
                }],
                "roles": [],
                "tabs": [
                    {
                        "id": first_tab_id,
                        "sourceId": "attestation-shared-role-a",
                        "name": first_tab_id,
                        "displayId": DISPLAY_ID,
                        "tabType": "role",
                        "roleIds": ["attestation-shared-role-a"],
                        "hidden": false
                    },
                    {
                        "id": second_tab_id,
                        "sourceId": "attestation-shared-role-b",
                        "name": second_tab_id,
                        "displayId": DISPLAY_ID,
                        "tabType": "role",
                        "roleIds": ["attestation-shared-role-b"],
                        "hidden": false
                    }
                ],
                "workspaces": []
            }))
            .map_err(|error| input_attestation_error(error.to_string()))
        };
        runtime.apply_runtime(
            snapshot(first_tab_id)?,
            Some(target.clone()),
            &[DISPLAY_ID],
            &[],
            None,
        )?;
        let (window_label, native_handle, surface_labels, first_webview, first_navigation) = {
            let state = runtime.state()?;
            let host = state.display_hosts.get(&DISPLAY_ID).ok_or_else(|| {
                input_attestation_error("The shared display host was not created.")
            })?;
            if state
                .tabs
                .values()
                .filter(|tab| tab.display_id == DISPLAY_ID)
                .count()
                != 2
            {
                return Err(input_attestation_error(
                    "Two tabs did not share one display host.",
                ));
            }
            (
                host.window.label().to_owned(),
                runtime_window_native_identity(&host.window)?,
                state
                    .tabs
                    .values()
                    .flat_map(|tab| tab.roles.values())
                    .map(|role| role.webview.label().to_owned())
                    .collect::<HashSet<_>>(),
                state.tabs[first_tab_id]
                    .roles
                    .values()
                    .next()
                    .map(|role| role.webview.clone())
                    .ok_or_else(|| {
                        input_attestation_error("The first shared-host tab has no role surface.")
                    })?,
                state.tabs[first_tab_id]
                    .roles
                    .values()
                    .next()
                    .map(|role| Arc::clone(&role.navigation))
                    .ok_or_else(|| {
                        input_attestation_error(
                            "The first shared-host tab has no navigation state.",
                        )
                    })?,
            )
        };
        first_navigation.reset();
        first_webview
            .navigate(checked_web_url(&server.url("attestation-shared-role-a"))?)
            .map_err(RuntimeError::tauri)?;
        first_navigation.wait().map_err(|message| {
            RuntimeError::new("SYSTEM_ROLE_PARITY_NAVIGATION_FAILED", message)
        })?;
        let marker = evaluate_attestation_value(
            &first_webview,
            "(globalThis.__rionSharedHostState = { value: 'stable' }, ({ value: globalThis.__rionSharedHostState.value }))",
        )?;
        if marker.get("value") != Some(&json!("stable")) {
            return Err(input_attestation_error(
                "The shared-host content marker could not be installed before tab activation.",
            ));
        }
        runtime.apply_runtime(snapshot(second_tab_id)?, None, &[DISPLAY_ID], &[], None)?;
        let state = runtime.state()?;
        let host = state.display_hosts.get(&DISPLAY_ID).ok_or_else(|| {
            input_attestation_error("The shared display host disappeared after tab activation.")
        })?;
        let next_surface_labels = state
            .tabs
            .values()
            .flat_map(|tab| tab.roles.values())
            .map(|role| role.webview.label().to_owned())
            .collect::<HashSet<_>>();
        let window_label_stable = host.window.label() == window_label;
        let native_handle_stable = runtime_window_native_identity(&host.window)? == native_handle;
        let surface_labels_stable = next_surface_labels == surface_labels;
        drop(state);
        let content_state_stable = evaluate_attestation_value(
            &first_webview,
            "({ value: globalThis.__rionSharedHostState?.value ?? null })",
        )?
        .get("value")
            == Some(&json!("stable"));
        if !window_label_stable
            || !native_handle_stable
            || !surface_labels_stable
            || !content_state_stable
        {
            return Err(input_attestation_error(
                "Tab activation replaced the shared native host, a role surface, or its content state.",
            ));
        }
        Ok(json!({
            "contentStateStable": content_state_stable,
            "hostCount": 1,
            "tabCount": 2,
            "nativeHandleStable": native_handle_stable,
            "surfaceLabelsStable": surface_labels_stable,
            "windowLabelStable": window_label_stable
        }))
    })();
    let _ = runtime.destroy_tab(first_tab_id);
    let cleanup = runtime.destroy_tab(second_tab_id);
    result.and_then(|report| cleanup.map(|()| report))
}

#[cfg(target_os = "macos")]
fn runtime_window_native_identity(window: &Window) -> RuntimeResult<usize> {
    window
        .ns_window()
        .map(|value| value as usize)
        .map_err(RuntimeError::tauri)
}

#[cfg(windows)]
fn runtime_window_native_identity(window: &Window) -> RuntimeResult<usize> {
    window
        .hwnd()
        .map(|value| value.0 as usize)
        .map_err(RuntimeError::tauri)
}

#[cfg(any(windows, target_os = "macos"))]
fn verify_surface_recovery_attestation(
    runtime: &Arc<SystemRuntimeExecutor>,
) -> RuntimeResult<Option<Value>> {
    let role_id = "attestation-1-0";
    let old_webview = runtime.role_webview(role_id)?;
    let old_label = old_webview.label().to_owned();
    eprintln!("System WebView parity: validating OS process-failure recovery callback.");
    terminate_surface_for_attestation(&old_webview)?;
    let deadline = Instant::now() + NAVIGATION_TIMEOUT;
    let recovered = loop {
        if let Ok(state) = runtime.state()
            && !state.recovering_roles.contains(role_id)
            && state
                .recovery_generations
                .get(role_id)
                .copied()
                .unwrap_or(0)
                >= 1
            && let Some(tab_id) = state.role_tabs.get(role_id)
            && let Some(surface) = state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(role_id))
            && surface.webview.label() != old_label
        {
            break surface.webview.clone();
        }
        if Instant::now() >= deadline {
            return Err(input_attestation_error(
                "The System WebView surface recovery did not replace the native handle.",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stored =
        evaluate_system_webview(&recovered, "localStorage.getItem('rion-attestation-role')")?;
    if serde_json::from_str::<Value>(&stored).ok() != Some(json!(role_id)) {
        return Err(input_attestation_error(format!(
            "The recovered System WebView lost its role store: {stored}."
        )));
    }
    recovered
        .eval(TRUSTED_INPUT_ATTESTATION_SOURCE)
        .map_err(RuntimeError::tauri)?;
    attest_key(&recovered, "rawKeyDown", "KeyA", &["KeyA"], false)?;
    attest_key(&recovered, "keyUp", "KeyA", &[], false)?;
    let input = attestation_snapshot(&recovered)?;
    for (field, expected) in [
        ("allTrusted", json!(true)),
        ("backgroundOnly", json!(true)),
        ("heldCount", json!(0)),
        ("keyDown", json!(1)),
        ("keyUp", json!(1)),
    ] {
        require_attestation_field(&input, field, expected)?;
    }
    let release_deadline = Instant::now() + PLATFORM_CALLBACK_TIMEOUT;
    while runtime.app.get_webview(&old_label).is_some() {
        if Instant::now() >= release_deadline {
            return Err(input_attestation_error(
                "The recovered System WebView retained its old native handle.",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(Some(json!({
        "inputRestored": true,
        "nativeHandleReplaced": true,
        "oldHandleReleased": true,
        "processTerminationObserved": true,
        "roleStorePreserved": true
    })))
}

#[cfg(any(windows, target_os = "macos"))]
fn verify_popup_download_attestation(
    runtime: &SystemRuntimeExecutor,
) -> RuntimeResult<Option<Value>> {
    let role_id = "attestation-1-0";
    let parent = runtime.role_webview(role_id)?;
    eprintln!("System WebView parity: validating same-session popup.");
    dispatch_mouse_effect(&parent, ClickPoint { x: 80, y: 50 }, "left", true)?;
    std::thread::sleep(Duration::from_millis(2));
    dispatch_mouse_effect(&parent, ClickPoint { x: 80, y: 50 }, "left", false)?;

    let popup_label = wait_for_attestation_popup(runtime, role_id)?;
    let popup = runtime.app.get_webview(&popup_label).ok_or_else(|| {
        input_attestation_error("The System WebView popup was registered without a WebView.")
    })?;
    let deadline = Instant::now() + NAVIGATION_TIMEOUT;
    let popup_state = loop {
        if let Ok(value) = evaluate_attestation_value(
            &popup,
            "({ ready: document.readyState === 'complete' && location.pathname === '/popup', role: localStorage.getItem('rion-attestation-role') })",
        ) && value.get("ready") == Some(&Value::Bool(true))
        {
            break value;
        }
        if Instant::now() >= deadline {
            return Err(input_attestation_error(
                "The same-session System WebView popup did not finish loading.",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if popup_state.get("role") != Some(&json!(role_id)) {
        return Err(input_attestation_error(format!(
            "The System WebView popup did not share its parent role store: {popup_state}."
        )));
    }
    if let Some(window) = runtime.app.get_webview_window(&popup_label) {
        window.close().map_err(RuntimeError::tauri)?;
    }
    wait_for_attestation_popup_release(runtime, &popup_label)?;

    let tracker = runtime
        .configuration
        .download_attestation
        .as_ref()
        .ok_or_else(|| {
            input_attestation_error("The packaged runtime has no download attestation tracker.")
        })?;
    let upload_path = tracker.directory.join("rion-system-upload-attestation.txt");
    fs::write(&upload_path, UPLOAD_ATTESTATION_BODY).map_err(RuntimeError::io)?;
    eprintln!("System WebView parity: validating file upload selection and content.");
    let upload_selection = select_upload_file_for_attestation(&parent, &upload_path)?;
    let upload_deadline = Instant::now() + NAVIGATION_TIMEOUT;
    let upload = loop {
        if let Ok(value) =
            evaluate_attestation_value(&parent, "globalThis.__rionUploadAttestation ?? null")
            && !value.is_null()
        {
            break value;
        }
        if Instant::now() >= upload_deadline {
            return Err(input_attestation_error(
                "The System WebView file upload did not expose the selected file.",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let expected_name = upload_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let expected_text = std::str::from_utf8(UPLOAD_ATTESTATION_BODY).unwrap_or_default();
    if upload["name"].as_str() != Some(expected_name)
        || upload["size"].as_u64() != Some(UPLOAD_ATTESTATION_BODY.len() as u64)
        || upload["text"].as_str() != Some(expected_text)
    {
        return Err(input_attestation_error(format!(
            "The System WebView file upload content was invalid: {upload}."
        )));
    }
    tracker.reset()?;
    eprintln!("System WebView parity: validating native download.");
    dispatch_mouse_effect(&parent, ClickPoint { x: 80, y: 140 }, "left", true)?;
    std::thread::sleep(Duration::from_millis(2));
    dispatch_mouse_effect(&parent, ClickPoint { x: 80, y: 140 }, "left", false)?;
    let destination = tracker.wait()?;
    let downloaded = fs::read(&destination).map_err(RuntimeError::io)?;
    if downloaded != DOWNLOAD_ATTESTATION_BODY {
        return Err(input_attestation_error(format!(
            "The System WebView download content was invalid at {}.",
            destination.display()
        )));
    }
    Ok(Some(json!({
        "downloadCompleted": true,
        "downloadContentVerified": true,
        "nativeChooserCallbackObserved": upload_selection.native_chooser_callback_observed,
        "popupClosed": true,
        "popupSharedStore": true,
        "trustedPopupGesture": true,
        "uploadCompleted": true,
        "uploadContentVerified": true,
        "uploadSelectionMechanism": upload_selection.mechanism
    })))
}

#[cfg(any(windows, target_os = "macos"))]
struct UploadAttestationSelection {
    mechanism: &'static str,
    native_chooser_callback_observed: bool,
}

#[cfg(target_os = "macos")]
fn select_upload_file_for_attestation(
    webview: &Webview,
    path: &Path,
) -> RuntimeResult<UploadAttestationSelection> {
    use std::{ffi::CString, os::raw::c_char};

    unsafe extern "C" {
        fn rion_wk_install_upload_attestation(
            webview: *mut std::ffi::c_void,
            path: *const c_char,
        ) -> bool;
        fn rion_wk_upload_attestation_invoked(webview: *mut std::ffi::c_void) -> bool;
    }

    let path = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| {
        input_attestation_error("The upload attestation path contains an invalid character.")
    })?;
    let (install_sender, install_receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let installed = unsafe {
                rion_wk_install_upload_attestation(platform_webview.inner(), path.as_ptr())
            };
            let _ = install_sender.send(installed);
        })
        .map_err(RuntimeError::tauri)?;
    if install_receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) != Ok(true) {
        return Err(input_attestation_error(
            "WKWebView could not install the diagnostic open-panel callback.",
        ));
    }
    dispatch_mouse_effect(webview, ClickPoint { x: 130, y: 230 }, "left", true)?;
    std::thread::sleep(Duration::from_millis(2));
    dispatch_mouse_effect(webview, ClickPoint { x: 130, y: 230 }, "left", false)?;
    let deadline = Instant::now() + PLATFORM_CALLBACK_TIMEOUT;
    loop {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        webview
            .with_webview(move |platform_webview| {
                let invoked =
                    unsafe { rion_wk_upload_attestation_invoked(platform_webview.inner()) };
                let _ = sender.send(invoked);
            })
            .map_err(RuntimeError::tauri)?;
        if receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) == Ok(true) {
            return Ok(UploadAttestationSelection {
                mechanism: "wk-open-panel-callback",
                native_chooser_callback_observed: true,
            });
        }
        if Instant::now() >= deadline {
            return Err(input_attestation_error(
                "WKWebView did not invoke its native open-panel delegate for file upload.",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(windows)]
fn select_upload_file_for_attestation(
    webview: &Webview,
    path: &Path,
) -> RuntimeResult<UploadAttestationSelection> {
    let document = call_system_devtools(webview, "DOM.getDocument", &json!({ "depth": 1 }))?;
    let document = serde_json::from_str::<Value>(&document).map_err(|error| {
        input_attestation_error(format!(
            "WebView2 returned an invalid DOM document: {error}."
        ))
    })?;
    let root_node_id = document["root"]["nodeId"].as_i64().ok_or_else(|| {
        input_attestation_error("WebView2 did not return the upload document root node.")
    })?;
    let query = call_system_devtools(
        webview,
        "DOM.querySelector",
        &json!({ "nodeId": root_node_id, "selector": "#upload" }),
    )?;
    let query = serde_json::from_str::<Value>(&query).map_err(|error| {
        input_attestation_error(format!(
            "WebView2 returned an invalid upload node: {error}."
        ))
    })?;
    let node_id = query["nodeId"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            input_attestation_error("WebView2 did not find the upload input element.")
        })?;
    call_system_devtools(
        webview,
        "DOM.setFileInputFiles",
        &json!({
            "files": [path.to_string_lossy()],
            "nodeId": node_id
        }),
    )?;
    Ok(UploadAttestationSelection {
        mechanism: "webview2-dom-set-file-input-files",
        native_chooser_callback_observed: false,
    })
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_attestation_popup(
    runtime: &SystemRuntimeExecutor,
    role_id: &str,
) -> RuntimeResult<String> {
    let deadline = Instant::now() + NAVIGATION_TIMEOUT;
    loop {
        if let Some(label) = runtime
            .state()?
            .popup_roles
            .iter()
            .find_map(|(label, popup_role_id)| (popup_role_id == role_id).then(|| label.clone()))
        {
            return Ok(label);
        }
        if Instant::now() >= deadline {
            let input =
                attestation_snapshot(&runtime.role_webview(role_id)?).unwrap_or(Value::Null);
            let dom = evaluate_attestation_value(
                &runtime.role_webview(role_id)?,
                "({ hit: document.elementFromPoint(80, 50)?.id || document.elementFromPoint(80, 50)?.tagName, popup: document.getElementById('popup')?.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight } })",
            )
            .unwrap_or(Value::Null);
            return Err(input_attestation_error(format!(
                "The trusted System WebView popup gesture did not create a popup; input snapshot: {input}; DOM snapshot: {dom}."
            )));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_attestation_popup_release(
    runtime: &SystemRuntimeExecutor,
    popup_label: &str,
) -> RuntimeResult<()> {
    let deadline = Instant::now() + PLATFORM_CALLBACK_TIMEOUT;
    loop {
        if !runtime.state()?.popup_roles.contains_key(popup_label)
            && runtime.app.get_webview_window(popup_label).is_none()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(input_attestation_error(
                "The System WebView popup did not release its native window and role mapping.",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn run_create_destroy_attestation(runtime: &SystemRuntimeExecutor) -> RuntimeResult<u64> {
    const CYCLES: u64 = 100;
    for cycle in 0..CYCLES {
        if cycle % 25 == 0 {
            eprintln!("System WebView parity: create/destroy soak {cycle}/{CYCLES}.");
        }
        let tab_id = format!("attestation-soak-tab-{cycle}");
        let role_id = format!("attestation-soak-role-{cycle}");
        let mut role = attestation_role(1, 0);
        role.role.id = role_id.clone();
        role.role.name = format!("Attestation soak role {cycle}");
        runtime.create_tab(EmbeddedTabEffectRecord {
            tab_id: tab_id.clone(),
            source_id: role_id.clone(),
            name: format!("System WebView soak {cycle}"),
            workspace_id: None,
            workspace_template: None,
            workspace_appearance: WorkspaceAppearanceSettingsRecord {
                background: "black".to_owned(),
                gap: 2,
            },
            target: EmbeddedLaunchTargetRecord {
                display_id: -9_999,
                work_area: rion_core::StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 320,
                    height: 240,
                },
            },
            roles: vec![role],
        })?;
        runtime.destroy_tab(&tab_id)?;
        let state = runtime.state()?;
        if state.tabs.contains_key(&tab_id)
            || state.role_tabs.contains_key(&role_id)
            || state.display_hosts.contains_key(&-9_999)
        {
            return Err(input_attestation_error(format!(
                "System WebView create/destroy soak cycle {cycle} leaked runtime handles."
            )));
        }
    }
    eprintln!("System WebView parity: create/destroy soak {CYCLES}/{CYCLES} complete.");
    Ok(CYCLES)
}

#[cfg(any(windows, target_os = "macos"))]
fn attestation_role(count: usize, index: usize) -> EmbeddedRoleViewEffectRecord {
    let columns = match count {
        1 => 1,
        3 => 3,
        6 => 3,
        _ => 3,
    };
    let rows = count.div_ceil(columns);
    let column = index % columns;
    let row = index / columns;
    let role_id = format!("attestation-{count}-{index}");
    EmbeddedRoleViewEffectRecord {
        role: StateRoleRecord {
            id: role_id.clone(),
            game_id: "attestation-game".to_owned(),
            name: format!("Attestation role {index}"),
            launch_url: "http://127.0.0.1/".to_owned(),
            notes: String::new(),
            browser_engine_pin: None,
            cover_image_data_url: None,
            cover_image_dominant_color: None,
            created_at: "1970-01-01T00:00:00Z".to_owned(),
            updated_at: "1970-01-01T00:00:00Z".to_owned(),
        },
        resolved_engine: current_system_resolved_engine(),
        rect: StateNormalizedRectRecord {
            x: column as f64 / columns as f64,
            y: row as f64 / rows as f64,
            width: 1.0 / columns as f64,
            height: 1.0 / rows as f64,
        },
        zoom_factor: 1.0,
        zoom_mode: "fixed".to_owned(),
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn verify_attestation_tab(
    runtime: &SystemRuntimeExecutor,
    server: &AttestationServer,
    tab_id: &str,
    count: usize,
) -> RuntimeResult<()> {
    let (window, surfaces, workspace_gap) = {
        let state = runtime.state()?;
        let tab = state.tabs.get(tab_id).ok_or_else(|| {
            input_attestation_error(format!(
                "The {count}-role System WebView tab was not created."
            ))
        })?;
        let host = state.display_hosts.get(&tab.display_id).ok_or_else(|| {
            input_attestation_error(format!(
                "The {count}-role System WebView display host was not created."
            ))
        })?;
        if tab.roles.len() != count || host.window.is_visible().unwrap_or(true) {
            return Err(input_attestation_error(format!(
                "The {count}-role System WebView tab has invalid initial native state."
            )));
        }
        let surfaces = (0..count)
            .map(|index| {
                let role_id = format!("attestation-{count}-{index}");
                tab.roles
                    .get(&role_id)
                    .map(|role| {
                        (
                            role_id,
                            role.webview.clone(),
                            Arc::clone(&role.navigation),
                            role.rect.clone(),
                        )
                    })
                    .ok_or_else(|| {
                        input_attestation_error(format!(
                            "The {count}-role layout is missing role {index}."
                        ))
                    })
            })
            .collect::<RuntimeResult<Vec<_>>>()?;
        (host.window.clone(), surfaces, tab.workspace_appearance.gap)
    };
    let content_metrics = logical_window_content_metrics(&window)?;
    let expected_bounds = runtime
        .resolve_runtime_layout(
            content_metrics,
            surfaces
                .iter()
                .map(|(role_id, _, _, rect)| LayoutRoleInput {
                    role_id: role_id.clone(),
                    rect: LayoutRect {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                    },
                })
                .collect(),
            workspace_gap,
        )?
        .0;

    for (role_id, webview, navigation, rect) in &surfaces {
        eprintln!("System WebView parity: loading {role_id}.");
        let url = checked_web_url(&server.url(role_id))?;
        if let Ok(mut state) = runtime.state()
            && let Some(tab) = state.tabs.get_mut(tab_id)
            && let Some(surface) = tab.roles.get_mut(role_id)
        {
            surface.current_url = Some(url.clone());
        }
        navigation.reset();
        webview.navigate(url).map_err(RuntimeError::tauri)?;
        navigation.wait().map_err(|message| {
            RuntimeError::new("SYSTEM_ROLE_PARITY_NAVIGATION_FAILED", message)
        })?;
        let identity = serde_json::to_string(role_id)
            .map_err(|error| RuntimeError::new("SYSTEM_ROLE_PARITY_INVALID", error.to_string()))?;
        let source =
            format!("localStorage.setItem('rion-attestation-role', {identity}); ({identity})");
        let stored = evaluate_system_webview(webview, &source)?;
        if serde_json::from_str::<Value>(&stored).ok() != Some(json!(role_id)) {
            return Err(input_attestation_error(format!(
                "The {count}-role layout could not write isolated storage for {role_id}."
            )));
        }
        let viewport =
            evaluate_attestation_value(webview, "({ width: innerWidth, height: innerHeight })")?;
        let expected = expected_bounds
            .get(role_id)
            .copied()
            .unwrap_or_else(|| role_bounds_for_content(content_metrics, rect));
        let actual_width = viewport.get("width").and_then(Value::as_f64).unwrap_or(0.0);
        let actual_height = viewport
            .get("height")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if (actual_width - expected.width).abs() > 1.0
            || (actual_height - expected.height).abs() > 1.0
        {
            return Err(input_attestation_error(format!(
                "The {count}-role layout viewport for {role_id} was {actual_width}x{actual_height}, expected {}x{} from the native content area {}x{} with top inset {}.",
                expected.width,
                expected.height,
                content_metrics.width,
                content_metrics.height,
                content_metrics.top_inset
            )));
        }
    }
    eprintln!("System WebView parity: validating {count}-role storage isolation.");
    for (role_id, webview, _, _) in &surfaces {
        let stored =
            evaluate_system_webview(webview, "localStorage.getItem('rion-attestation-role')")?;
        if serde_json::from_str::<Value>(&stored).ok() != Some(json!(role_id)) {
            return Err(input_attestation_error(format!(
                "The {count}-role layout leaked System WebView storage for {role_id}."
            )));
        }
    }

    let first_role = &surfaces[0].0;
    eprintln!("System WebView parity: validating {count}-role audio mute.");
    runtime.set_role_audio_muted(first_role, true)?;
    if !runtime
        .state()?
        .tabs
        .get(tab_id)
        .is_some_and(|tab| tab.audio_muted)
    {
        return Err(input_attestation_error(format!(
            "The {count}-role layout did not apply native audio mute."
        )));
    }
    runtime.set_role_audio_muted(first_role, false)?;

    for (role_id, webview, _, _) in &surfaces {
        eprintln!("System WebView parity: validating trusted input for {role_id}.");
        webview
            .eval(TRUSTED_INPUT_ATTESTATION_SOURCE)
            .map_err(RuntimeError::tauri)?;
        let ready = evaluate_attestation_value(
            webview,
            "globalThis.__rionInputAttestation?.snapshot instanceof Function",
        )?;
        if ready != Value::Bool(true) {
            return Err(input_attestation_error(format!(
                "The {count}-role input fixture was not ready for {role_id}."
            )));
        }
        attest_key(webview, "rawKeyDown", "KeyA", &["KeyA"], false)?;
        attest_key(webview, "keyUp", "KeyA", &[], false)?;
        let snapshot = attestation_snapshot(webview)?;
        for (field, expected) in [
            ("allTrusted", json!(true)),
            ("backgroundOnly", json!(true)),
            ("documentFocused", json!(false)),
            ("heldCount", json!(0)),
            ("keyDown", json!(1)),
            ("keyUp", json!(1)),
        ] {
            require_attestation_field(&snapshot, field, expected).map_err(|error| {
                input_attestation_error(format!(
                    "The {count}-role input check failed for {role_id}: {}",
                    error.message
                ))
            })?;
        }
    }
    Ok(())
}

#[cfg(any(windows, target_os = "macos"))]
fn current_system_resolved_engine() -> ResolvedBrowserEngine {
    if cfg!(windows) {
        ResolvedBrowserEngine::Webview2
    } else {
        ResolvedBrowserEngine::Wkwebview
    }
}

#[cfg(any(windows, target_os = "macos"))]
struct AttestationServer {
    address: std::net::SocketAddr,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(any(windows, target_os = "macos"))]
impl AttestationServer {
    fn start() -> RuntimeResult<Self> {
        use std::sync::atomic::Ordering as AtomicOrdering;

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(RuntimeError::io)?;
        listener.set_nonblocking(true).map_err(RuntimeError::io)?;
        let address = listener.local_addr().map_err(RuntimeError::io)?;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("rion-input-attestation-server".to_owned())
            .spawn(move || {
                while !thread_stop.load(AtomicOrdering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => serve_attestation_fixture(&mut stream),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|error| {
                RuntimeError::new("SYSTEM_ROLE_PARITY_SERVER_FAILED", error.to_string())
            })?;
        Ok(Self {
            address,
            stop,
            thread: Some(thread),
        })
    }

    fn url(&self, role_id: &str) -> String {
        format!("http://{}/?role={role_id}", self.address)
    }
}

#[cfg(any(windows, target_os = "macos"))]
impl Drop for AttestationServer {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering as AtomicOrdering;

        self.stop.store(true, AtomicOrdering::Relaxed);
        let _ = std::net::TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn serve_attestation_fixture(stream: &mut std::net::TcpStream) {
    use std::io::{Read, Write};

    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut request = [0_u8; 8 * 1024];
    let read = stream.read(&mut request).unwrap_or(0);
    let request = String::from_utf8_lossy(&request[..read]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let path = if target.starts_with("http://") || target.starts_with("https://") {
        Url::parse(target)
            .ok()
            .map(|url| url.path().to_owned())
            .unwrap_or_else(|| "/".to_owned())
    } else {
        target.split('?').next().unwrap_or("/").to_owned()
    };
    const ROOT_BODY: &str = r#"<!doctype html>
<meta charset=utf-8>
<title>Rion System WebView parity</title>
<style>
  html,body { margin: 0; min-height: 100%; background: #111; }
  #popup,#download,#upload { position: fixed; left: 20px; height: 60px; }
  #popup,#download { width: 120px; }
  #popup { top: 20px; }
  #download { top: 110px; display: grid; place-items: center; background: #eee; color: #111; }
  #upload { top: 200px; width: 240px; color: #fff; }
</style>
<button id=popup type=button>Open popup</button>
<a id=download href=/download download=rion-system-download-attestation.bin>Download</a>
<input id=upload type=file>
<script>
document.getElementById('popup').addEventListener('click',()=>window.open('/popup','rion-system-popup','width=360,height=240'));
document.getElementById('upload').addEventListener('change',async(event)=>{
  const file=event.target.files?.[0];
  globalThis.__rionUploadAttestation=file?{name:file.name,size:file.size,text:await file.text()}:null;
});
</script>"#;
    const POPUP_BODY: &str = "<!doctype html><meta charset=utf-8><title>Rion System popup parity</title><body>popup ready</body>";
    let (content_type, disposition, body) = match path.as_str() {
        "/popup" => ("text/html; charset=utf-8", None, POPUP_BODY.as_bytes()),
        "/download" => (
            "application/octet-stream",
            Some("attachment; filename=\"rion-system-download-attestation.bin\""),
            DOWNLOAD_ATTESTATION_BODY,
        ),
        _ => ("text/html; charset=utf-8", None, ROOT_BODY.as_bytes()),
    };
    let disposition = disposition
        .map(|value| format!("Content-Disposition: {value}\r\n"))
        .unwrap_or_default();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n{disposition}Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

#[cfg(any(windows, target_os = "macos"))]
fn attest_key(
    webview: &Webview,
    phase: &str,
    code: &str,
    active_codes: &[&str],
    auto_repeat: bool,
) -> RuntimeResult<()> {
    dispatch_key_effect(
        webview,
        &EmbeddedKeyEffectRecord {
            phase: phase.to_owned(),
            code: code.to_owned(),
            active_codes_before: Vec::new(),
            active_codes: active_codes.iter().map(|code| (*code).to_owned()).collect(),
            auto_repeat,
            suppress_shortcut: false,
        },
    )?;
    // Pace the bounded native probe so its synthetic events cannot resemble a
    // stuck key or overwhelm the focused System WebView during dev startup.
    std::thread::sleep(TRUSTED_INPUT_EVENT_INTERVAL);
    Ok(())
}

#[cfg(any(windows, target_os = "macos"))]
fn attestation_snapshot(webview: &Webview) -> RuntimeResult<Value> {
    evaluate_attestation_value(webview, "__rionInputAttestation.snapshot()")
}

#[cfg(any(windows, target_os = "macos"))]
fn evaluate_attestation_value(webview: &Webview, source: &str) -> RuntimeResult<Value> {
    let source = evaluate_system_webview(webview, source)?;
    let value = serde_json::from_str::<Value>(&source).map_err(|error| {
        RuntimeError::new(
            "SYSTEM_INPUT_ATTESTATION_INVALID",
            format!("The System WebView returned invalid attestation JSON: {error}"),
        )
    })?;
    if let Some(nested) = value.as_str() {
        serde_json::from_str(nested).map_err(|error| {
            RuntimeError::new(
                "SYSTEM_INPUT_ATTESTATION_INVALID",
                format!("The System WebView returned invalid nested attestation JSON: {error}"),
            )
        })
    } else {
        Ok(value)
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn require_attestation_field(snapshot: &Value, field: &str, expected: Value) -> RuntimeResult<()> {
    if snapshot.get(field) == Some(&expected) {
        Ok(())
    } else {
        Err(input_attestation_error(format!(
            "The input fixture reported an unexpected {field}: expected {expected}, received {}; snapshot: {snapshot}.",
            snapshot.get(field).unwrap_or(&Value::Null),
        )))
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn input_attestation_error(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new("SYSTEM_INPUT_ATTESTATION_FAILED", message)
}

#[cfg(any(windows, target_os = "macos"))]
fn write_attestation_result(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Trusted-input attestation output has no parent directory.".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("attestation.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
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

fn compatibility_session_paths(
    user_data_dir: &Path,
    game_id: &str,
    started_at: &str,
) -> SessionPaths {
    let digest = Sha256::digest(format!("rion-studio:compatibility:{game_id}:{started_at}"));
    let mut identifier = [0_u8; 16];
    identifier.copy_from_slice(&digest[..16]);
    identifier[6] = (identifier[6] & 0x0f) | 0x80;
    identifier[8] = (identifier[8] & 0x3f) | 0x80;
    let encoded = format!("{digest:x}");
    SessionPaths {
        webkit_identifier: identifier,
        webview2: user_data_dir
            .join("compatibility")
            .join(&encoded[..32])
            .join("webview2"),
    }
}

fn checked_web_url(value: &str) -> RuntimeResult<Url> {
    let url = Url::parse(value)
        .map_err(|_| RuntimeError::new("TAURI_URL_INVALID", "Role URL is invalid."))?;
    if matches!(url.scheme(), "http" | "https") {
        Ok(url)
    } else {
        Err(RuntimeError::new(
            "TAURI_URL_INVALID",
            "Role URL must use HTTP or HTTPS.",
        ))
    }
}

fn macro_overlay_document_start_script() -> Result<String, String> {
    let guard_token = serde_json::to_string(MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN)
        .map_err(|error| error.to_string())?;
    let css_token =
        serde_json::to_string(MACRO_OVERLAY_CSS_TOKEN).map_err(|error| error.to_string())?;
    let with_guard = replace_single_overlay_token(
        MACRO_OVERLAY_RUNTIME_SOURCE,
        &guard_token,
        MACRO_OVERLAY_SHORTCUT_GUARD_SOURCE.trim(),
    )?;
    let css = serde_json::to_string(MACRO_OVERLAY_CSS).map_err(|error| error.to_string())?;
    let runtime = replace_single_overlay_token(&with_guard, &css_token, &css)?;
    Ok(format!("{TAURI_MACRO_OVERLAY_BRIDGE_SOURCE}\n{runtime}"))
}

fn replace_single_overlay_token(
    source: &str,
    token: &str,
    replacement: &str,
) -> Result<String, String> {
    let mut matches = source.match_indices(token);
    let Some((index, _)) = matches.next() else {
        return Err(format!("Macro overlay token is missing: {token}"));
    };
    if matches.next().is_some() {
        return Err(format!(
            "Macro overlay token occurs more than once: {token}"
        ));
    }
    Ok(format!(
        "{}{}{}",
        &source[..index],
        replacement,
        &source[index + token.len()..]
    ))
}

fn native_font_document_start_script(settings: &GameBrowserSettingsRecord) -> String {
    if settings.fonts.mode != "custom" || settings.fonts.families.is_empty() {
        return String::new();
    }
    let families = &settings.fonts.families;
    let mut rules = Vec::new();
    push_font_rule(
        &mut rules,
        ":where(html,body,button,input,select,textarea)",
        families
            .get("standard")
            .or_else(|| families.get("sansserif")),
    );
    push_font_rule(
        &mut rules,
        ":where(button,input,select,textarea)",
        families
            .get("sansserif")
            .or_else(|| families.get("standard")),
    );
    push_font_rule(
        &mut rules,
        ":where(article,blockquote,q)",
        families.get("serif"),
    );
    push_font_rule(
        &mut rules,
        ":where(code,kbd,pre,samp,textarea)",
        families.get("fixed"),
    );
    push_font_rule(&mut rules, "math", families.get("math"));
    if rules.is_empty() {
        return String::new();
    }
    let css = serde_json::to_string(&rules.join("\n")).unwrap_or_else(|_| "\"\"".to_owned());
    format!(
        r#"(() => {{
  const styleId = "rion-studio-native-browser-fonts";
  const css = {css};
  const install = () => {{
    const root = document.documentElement;
    if (!root || document.getElementById(styleId)) return false;
    try {{
      if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in document) {{
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        root.dataset.rionStudioNativeFonts = "adopted";
        return true;
      }}
    }} catch {{}}
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = css;
    (document.head || root).appendChild(style);
    root.dataset.rionStudioNativeFonts = "style";
    return true;
  }};
  if (!install()) {{
    document.addEventListener("readystatechange", install, {{ once: true }});
    document.addEventListener("DOMContentLoaded", install, {{ once: true }});
  }}
}})();"#
    )
}

fn push_font_rule(rules: &mut Vec<String>, selector: &str, family: Option<&String>) {
    let Some(family) = family else {
        return;
    };
    let family = family
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\a ")
        .replace('\r', "\\d ");
    rules.push(format!(
        "{selector}{{font-family:\"{family}\" !important;}}"
    ));
}

#[derive(Clone, Copy)]
struct RoleBounds {
    height: f64,
    width: f64,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy)]
struct WindowContentMetrics {
    height: f64,
    top_inset: f64,
    width: f64,
}

type ResolvedRuntimeLayout = (
    HashMap<String, RoleBounds>,
    Vec<(u32, WorkspaceDividerDescriptor, RoleBounds)>,
);

fn role_bounds_for_size(
    width: f64,
    height: f64,
    rect: &rion_core::StateNormalizedRectRecord,
) -> RoleBounds {
    RoleBounds {
        x: (rect.x * width).round().max(0.0),
        y: (rect.y * height).round().max(0.0),
        width: (rect.width * width).round().max(1.0),
        height: (rect.height * height).round().max(1.0),
    }
}

fn role_bounds_for_content(
    metrics: WindowContentMetrics,
    rect: &rion_core::StateNormalizedRectRecord,
) -> RoleBounds {
    let mut bounds = role_bounds_for_size(metrics.width, metrics.height, rect);
    bounds.y += metrics.top_inset;
    bounds
}

fn divider_hit_bounds(axis: &str, mut bounds: RoleBounds) -> RoleBounds {
    if axis == "vertical" && bounds.width < DIVIDER_HIT_TARGET {
        bounds.x -= (DIVIDER_HIT_TARGET - bounds.width) / 2.0;
        bounds.width = DIVIDER_HIT_TARGET;
    } else if axis == "horizontal" && bounds.height < DIVIDER_HIT_TARGET {
        bounds.y -= (DIVIDER_HIT_TARGET - bounds.height) / 2.0;
        bounds.height = DIVIDER_HIT_TARGET;
    }
    bounds
}

fn format_ratio(value: f64) -> String {
    let percent = (value * 1_000.0).round() / 10.0;
    if percent.fract().abs() < f64::EPSILON {
        format!("{percent:.0}%")
    } else {
        format!("{percent:.1}%")
    }
}

#[cfg(windows)]
fn runtime_window_content_metrics(window: &Window) -> RuntimeResult<WindowContentMetrics> {
    runtime_window_content_metrics_with_tab_strip(window, WINDOWS_TAB_STRIP_HEIGHT)
}

#[cfg(windows)]
fn runtime_window_content_metrics_with_tab_strip(
    window: &Window,
    tab_strip_height: f64,
) -> RuntimeResult<WindowContentMetrics> {
    let mut metrics = logical_window_content_metrics(window)?;
    metrics.top_inset += tab_strip_height;
    metrics.height = (metrics.height - tab_strip_height).max(1.0);
    Ok(metrics)
}

#[cfg(not(windows))]
fn runtime_window_content_metrics(window: &Window) -> RuntimeResult<WindowContentMetrics> {
    logical_window_content_metrics(window)
}

fn logical_window_content_metrics(window: &Window) -> RuntimeResult<WindowContentMetrics> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn rion_wk_window_content_layout_metrics(
                window: *mut std::ffi::c_void,
                width: *mut f64,
                height: *mut f64,
                top_inset: *mut f64,
            ) -> bool;
        }
        let window = window.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        window
            .clone()
            .run_on_main_thread(move || {
                let result = window.ns_window().ok().and_then(|native| {
                    let mut width = 0.0;
                    let mut height = 0.0;
                    let mut top_inset = 0.0;
                    unsafe {
                        rion_wk_window_content_layout_metrics(
                            native,
                            &mut width,
                            &mut height,
                            &mut top_inset,
                        )
                    }
                    .then_some(WindowContentMetrics {
                        height,
                        top_inset,
                        width,
                    })
                });
                let _ = sender.send(result);
            })
            .map_err(RuntimeError::tauri)?;
        receiver
            .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
            .map_err(|_| {
                RuntimeError::new(
                    "TAURI_WINDOW_CONTENT_SIZE_TIMEOUT",
                    "The macOS content layout size query timed out.",
                )
            })?
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_WINDOW_CONTENT_SIZE_FAILED",
                    "The macOS content layout size was unavailable.",
                )
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let physical = window.inner_size().map_err(RuntimeError::tauri)?;
        let scale_factor = window
            .scale_factor()
            .map_err(RuntimeError::tauri)?
            .max(f64::EPSILON);
        Ok(WindowContentMetrics {
            height: (physical.height as f64 / scale_factor).max(1.0),
            top_inset: 0.0,
            width: (physical.width as f64 / scale_factor).max(1.0),
        })
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

fn trusted_input_status(available: bool, attested: bool) -> EngineCapabilityStatus {
    if !available {
        EngineCapabilityStatus::Disabled
    } else if attested {
        EngineCapabilityStatus::Supported
    } else {
        EngineCapabilityStatus::Degraded
    }
}

#[cfg(target_os = "macos")]
fn trusted_input_attested() -> bool {
    unsafe extern "C" {
        fn rion_wk_operating_system_major_version() -> u64;
    }
    option_env!("RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR")
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|major| major == unsafe { rion_wk_operating_system_major_version() })
}

#[cfg(windows)]
fn trusted_input_attested() -> bool {
    option_env!("RION_STUDIO_WINDOWS_INPUT_ATTESTED") == Some("1")
}

#[cfg(not(any(windows, target_os = "macos")))]
fn trusted_input_attested() -> bool {
    false
}

fn degraded_if(available: bool) -> EngineCapabilityStatus {
    if available {
        EngineCapabilityStatus::Degraded
    } else {
        EngineCapabilityStatus::Disabled
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ViewportSize {
    height: f64,
    width: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ClickPoint {
    x: i64,
    y: i64,
}

fn parse_devtools_params(params_json: &str) -> RuntimeResult<Value> {
    let params = serde_json::from_str::<Value>(params_json).map_err(|error| {
        RuntimeError::new(
            "BROWSER_DEBUGGER_PARAMS_INVALID",
            format!("Debugger parameters are invalid JSON: {error}"),
        )
    })?;
    if params.is_object() {
        Ok(params)
    } else {
        Err(RuntimeError::new(
            "BROWSER_DEBUGGER_PARAMS_INVALID",
            "Debugger parameters must be a JSON object.",
        ))
    }
}

fn resolve_modifier_codes(modifiers: &[String], macos: bool) -> RuntimeResult<Vec<String>> {
    let mut result = Vec::new();
    for modifier in modifiers {
        let code = match modifier.as_str() {
            "primary" if macos => "MetaLeft",
            "primary" | "ctrl" => "ControlLeft",
            "alt" => "AltLeft",
            "shift" => "ShiftLeft",
            "meta" => "MetaLeft",
            _ => {
                return Err(RuntimeError::new(
                    "BROWSER_KEY_MODIFIER_INVALID",
                    format!("Unsupported key modifier: {modifier}"),
                ));
            }
        };
        if !result.iter().any(|current| current == code) {
            result.push(code.to_owned());
        }
    }
    Ok(result)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn cdp_modifier_mask(active_codes: &[String]) -> u8 {
    active_codes.iter().fold(0, |mask, code| {
        mask | match code.as_str() {
            "AltLeft" | "AltRight" => 1,
            "ControlLeft" | "ControlRight" => 2,
            "MetaLeft" | "MetaRight" => 4,
            "ShiftLeft" | "ShiftRight" => 8,
            _ => 0,
        }
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
fn cdp_key_descriptor(code: &str, modifiers: u8) -> Value {
    let shift = modifiers & 8 != 0;
    let key = if code.len() == 4 && code.starts_with("Key") {
        let value = &code[3..];
        if shift {
            value.to_owned()
        } else {
            value.to_ascii_lowercase()
        }
    } else if code.len() == 6 && code.starts_with("Digit") {
        if shift {
            shifted_digit_key(code).unwrap_or(&code[5..]).to_owned()
        } else {
            code[5..].to_owned()
        }
    } else if shift {
        shifted_named_key(code)
            .or_else(|| named_key(code))
            .unwrap_or(code)
            .to_owned()
    } else {
        named_key(code).unwrap_or(code).to_owned()
    };
    let mut descriptor = serde_json::Map::new();
    descriptor.insert("code".to_owned(), json!(code));
    descriptor.insert("key".to_owned(), json!(key));
    if let Some(virtual_key_code) = windows_virtual_key_code(code, &key) {
        descriptor.insert("windowsVirtualKeyCode".to_owned(), json!(virtual_key_code));
    }
    if let Some(location) = key_location(code) {
        descriptor.insert("location".to_owned(), json!(location));
    }
    Value::Object(descriptor)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn named_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "AltLeft" | "AltRight" => "Alt",
        "ControlLeft" | "ControlRight" => "Control",
        "MetaLeft" | "MetaRight" => "Meta",
        "ShiftLeft" | "ShiftRight" => "Shift",
        "ArrowDown" => "ArrowDown",
        "ArrowLeft" => "ArrowLeft",
        "ArrowRight" => "ArrowRight",
        "ArrowUp" => "ArrowUp",
        "Backquote" => "`",
        "Backslash" => "\\",
        "Backspace" => "Backspace",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Comma" => ",",
        "Enter" => "Enter",
        "Equal" => "=",
        "Escape" => "Escape",
        "Minus" => "-",
        "Period" => ".",
        "Quote" => "'",
        "Semicolon" => ";",
        "Slash" => "/",
        "Space" => " ",
        "Tab" => "Tab",
        "NumpadAdd" => "+",
        "NumpadDecimal" => ".",
        "NumpadDivide" => "/",
        "NumpadMultiply" => "*",
        "NumpadSubtract" => "-",
        _ => return None,
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
fn shifted_digit_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "Digit0" => ")",
        "Digit1" => "!",
        "Digit2" => "@",
        "Digit3" => "#",
        "Digit4" => "$",
        "Digit5" => "%",
        "Digit6" => "^",
        "Digit7" => "&",
        "Digit8" => "*",
        "Digit9" => "(",
        _ => return None,
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
fn shifted_named_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "Backquote" => "~",
        "Backslash" => "|",
        "BracketLeft" => "{",
        "BracketRight" => "}",
        "Comma" => "<",
        "Equal" => "+",
        "Minus" => "_",
        "Period" => ">",
        "Quote" => "\"",
        "Semicolon" => ":",
        "Slash" => "?",
        _ => return None,
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_virtual_key_code(code: &str, key: &str) -> Option<u32> {
    if code.len() == 4 && code.starts_with("Key") {
        return code.as_bytes().get(3).copied().map(u32::from);
    }
    if code.len() == 6 && code.starts_with("Digit") {
        return code.as_bytes().get(5).copied().map(u32::from);
    }
    if let Some(number) = code
        .strip_prefix('F')
        .and_then(|value| value.parse::<u32>().ok())
        && (1..=12).contains(&number)
    {
        return Some(111 + number);
    }
    let named = match code {
        "AltLeft" | "AltRight" => Some(18),
        "ControlLeft" | "ControlRight" => Some(17),
        "MetaLeft" => Some(91),
        "MetaRight" => Some(92),
        "ShiftLeft" | "ShiftRight" => Some(16),
        "Backspace" => Some(8),
        "Tab" => Some(9),
        "Enter" => Some(13),
        "Escape" => Some(27),
        "Space" => Some(32),
        "ArrowLeft" => Some(37),
        "ArrowUp" => Some(38),
        "ArrowRight" => Some(39),
        "ArrowDown" => Some(40),
        "Semicolon" => Some(186),
        "Equal" => Some(187),
        "Comma" => Some(188),
        "Minus" => Some(189),
        "Period" => Some(190),
        "Slash" => Some(191),
        "Backquote" => Some(192),
        "BracketLeft" => Some(219),
        "Backslash" => Some(220),
        "BracketRight" => Some(221),
        "Quote" => Some(222),
        "NumpadMultiply" => Some(106),
        "NumpadAdd" => Some(107),
        "NumpadSubtract" => Some(109),
        "NumpadDecimal" => Some(110),
        "NumpadDivide" => Some(111),
        _ => None,
    };
    named.or_else(|| {
        let mut characters = key.chars();
        let first = characters.next()?;
        characters
            .next()
            .is_none()
            .then(|| first.to_ascii_uppercase() as u32)
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
fn key_location(code: &str) -> Option<u8> {
    if matches!(code, "AltLeft" | "ControlLeft" | "MetaLeft" | "ShiftLeft") {
        Some(1)
    } else if matches!(
        code,
        "AltRight" | "ControlRight" | "MetaRight" | "ShiftRight"
    ) {
        Some(2)
    } else if code.starts_with("Numpad") {
        Some(3)
    } else {
        None
    }
}

#[cfg(windows)]
fn dispatch_key_effect(webview: &Webview, effect: &EmbeddedKeyEffectRecord) -> RuntimeResult<()> {
    let modifiers = cdp_modifier_mask(&effect.active_codes);
    let mut parameters = cdp_key_descriptor(&effect.code, modifiers);
    let object = parameters
        .as_object_mut()
        .expect("CDP key descriptor is always an object");
    object.insert("type".to_owned(), json!(effect.phase));
    if effect.auto_repeat {
        object.insert("autoRepeat".to_owned(), json!(true));
    }
    if modifiers > 0 {
        object.insert("modifiers".to_owned(), json!(modifiers));
    }
    call_system_devtools(webview, "Input.dispatchKeyEvent", &parameters).map(|_| ())
}

#[cfg(target_os = "macos")]
fn dispatch_key_effect(webview: &Webview, effect: &EmbeddedKeyEffectRecord) -> RuntimeResult<()> {
    use std::{ffi::CString, os::raw::c_char};

    unsafe extern "C" {
        fn rion_wk_dispatch_key(
            webview: *mut std::ffi::c_void,
            code: *const c_char,
            key_down: bool,
            modifier_flags: u64,
            repeat: bool,
        ) -> bool;
    }

    let code = CString::new(effect.code.as_str()).map_err(|_| {
        RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_INVALID",
            "The macOS key code contains an invalid character.",
        )
    })?;
    let key_down = effect.phase == "rawKeyDown";
    let modifier_flags = mac_modifier_flags(&effect.active_codes);
    let repeat = effect.auto_repeat;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let succeeded = unsafe {
                rion_wk_dispatch_key(
                    platform_webview.inner(),
                    code.as_ptr(),
                    key_down,
                    modifier_flags,
                    repeat,
                )
            };
            let _ = sender.send(succeeded);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err(RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
            format!("WKWebView rejected the native {} event.", effect.code),
        )),
        Err(_) => Err(RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_TIMEOUT",
            "WKWebView native key dispatch timed out.",
        )),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn dispatch_key_effect(_webview: &Webview, _effect: &EmbeddedKeyEffectRecord) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
        "Trusted System WebView input is unavailable on this platform.",
    ))
}

#[cfg(target_os = "macos")]
fn mac_modifier_flags(active_codes: &[String]) -> u64 {
    const SHIFT: u64 = 1 << 17;
    const CONTROL: u64 = 1 << 18;
    const OPTION: u64 = 1 << 19;
    const COMMAND: u64 = 1 << 20;

    active_codes.iter().fold(0, |flags, code| {
        flags
            | match code.as_str() {
                "ShiftLeft" | "ShiftRight" => SHIFT,
                "ControlLeft" | "ControlRight" => CONTROL,
                "AltLeft" | "AltRight" => OPTION,
                "MetaLeft" | "MetaRight" => COMMAND,
                _ => 0,
            }
    })
}

#[cfg(windows)]
fn dispatch_mouse_effect(
    webview: &Webview,
    point: ClickPoint,
    button: &str,
    pressed: bool,
) -> RuntimeResult<()> {
    call_system_devtools(
        webview,
        "Input.dispatchMouseEvent",
        &json!({
            "type": if pressed { "mousePressed" } else { "mouseReleased" },
            "button": button,
            "clickCount": 1,
            "x": point.x,
            "y": point.y,
        }),
    )
    .map(|_| ())
}

#[cfg(target_os = "macos")]
fn dispatch_mouse_effect(
    webview: &Webview,
    point: ClickPoint,
    button: &str,
    pressed: bool,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_dispatch_mouse(
            webview: *mut std::ffi::c_void,
            x: f64,
            y: f64,
            button: i32,
            pressed: bool,
        ) -> bool;
    }

    let button = match button {
        "left" => 0,
        "middle" => 1,
        "right" => 2,
        _ => {
            return Err(RuntimeError::new(
                "BROWSER_CLICK_INVALID",
                "Mouse button is invalid.",
            ));
        }
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let succeeded = unsafe {
                rion_wk_dispatch_mouse(
                    platform_webview.inner(),
                    point.x as f64,
                    point.y as f64,
                    button,
                    pressed,
                )
            };
            let _ = sender.send(succeeded);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err(RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
            "WKWebView rejected the native mouse event.",
        )),
        Err(_) => Err(RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_TIMEOUT",
            "WKWebView native mouse dispatch timed out.",
        )),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn dispatch_mouse_effect(
    _webview: &Webview,
    _point: ClickPoint,
    _button: &str,
    _pressed: bool,
) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "SYSTEM_TRUSTED_INPUT_UNAVAILABLE",
        "Trusted System WebView input is unavailable on this platform.",
    ))
}

fn compensated_key_effect(effect: &EmbeddedKeyEffectRecord) -> EmbeddedKeyEffectRecord {
    EmbeddedKeyEffectRecord {
        phase: if effect.phase == "rawKeyDown" {
            "keyUp".to_owned()
        } else {
            "rawKeyDown".to_owned()
        },
        code: effect.code.clone(),
        active_codes_before: effect.active_codes.clone(),
        active_codes: effect.active_codes_before.clone(),
        auto_repeat: false,
        suppress_shortcut: effect.suppress_shortcut,
    }
}

fn parse_devtools_viewport(source: &str) -> Option<ViewportSize> {
    let value = serde_json::from_str::<Value>(source).ok()?;
    for key in ["cssVisualViewport", "layoutViewport"] {
        if let Some(viewport) = value.get(key)
            && let Some(size) = viewport_size_from_value(viewport)
        {
            return Some(size);
        }
    }
    None
}

fn parse_evaluated_viewport(source: &str) -> Option<ViewportSize> {
    let value = serde_json::from_str::<Value>(source).ok()?;
    if let Some(size) = viewport_size_from_value(&value) {
        return Some(size);
    }
    value
        .as_str()
        .and_then(|nested| serde_json::from_str::<Value>(nested).ok())
        .and_then(|nested| viewport_size_from_value(&nested))
}

fn viewport_size_from_value(value: &Value) -> Option<ViewportSize> {
    let width = value
        .get("clientWidth")
        .or_else(|| value.get("width"))?
        .as_f64()?;
    let height = value
        .get("clientHeight")
        .or_else(|| value.get("height"))?
        .as_f64()?;
    (width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0)
        .then_some(ViewportSize { width, height })
}

fn resolve_click_point(
    anchor: Option<&str>,
    unit: &str,
    x: f64,
    y: f64,
    viewport: ViewportSize,
) -> RuntimeResult<ClickPoint> {
    if !x.is_finite() || !y.is_finite() {
        return Err(RuntimeError::new(
            "BROWSER_CLICK_INVALID",
            "Click coordinates must be finite.",
        ));
    }
    let (anchor_x, anchor_y) = match anchor.unwrap_or("top-left") {
        "top-left" => (0.0, 0.0),
        "top-center" => (50.0, 0.0),
        "top-right" => (100.0, 0.0),
        "center-left" => (0.0, 50.0),
        "center" => (50.0, 50.0),
        "center-right" => (100.0, 50.0),
        "bottom-left" => (0.0, 100.0),
        "bottom-center" => (50.0, 100.0),
        "bottom-right" => (100.0, 100.0),
        _ => {
            return Err(RuntimeError::new(
                "BROWSER_CLICK_INVALID",
                "Click anchor is invalid.",
            ));
        }
    };
    let (raw_x, raw_y) = match unit {
        "percent" => (
            viewport.width * (anchor_x + x) / 100.0,
            viewport.height * (anchor_y + y) / 100.0,
        ),
        "px" => (
            viewport.width * anchor_x / 100.0 + x,
            viewport.height * anchor_y / 100.0 + y,
        ),
        _ => {
            return Err(RuntimeError::new(
                "BROWSER_CLICK_INVALID",
                "Click coordinate unit is invalid.",
            ));
        }
    };
    Ok(ClickPoint {
        x: raw_x.round().clamp(0.0, (viewport.width - 1.0).max(0.0)) as i64,
        y: raw_y.round().clamp(0.0, (viewport.height - 1.0).max(0.0)) as i64,
    })
}

fn validate_mouse_button(button: &str) -> RuntimeResult<&str> {
    if matches!(button, "left" | "middle" | "right") {
        Ok(button)
    } else {
        Err(RuntimeError::new(
            "BROWSER_CLICK_INVALID",
            "Mouse button is invalid.",
        ))
    }
}

#[cfg(target_os = "macos")]
fn terminate_surface_for_attestation(webview: &Webview) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_terminate_web_content_process(webview: *mut std::ffi::c_void) -> bool;
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let terminated =
                unsafe { rion_wk_terminate_web_content_process(platform_webview.inner()) };
            let _ = sender.send(terminated);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err(input_attestation_error(
            "WKWebView did not expose the diagnostic web-content termination selector.",
        )),
        Err(_) => Err(input_attestation_error(
            "WKWebView web-content termination dispatch timed out.",
        )),
    }
}

#[cfg(windows)]
fn terminate_surface_for_attestation(webview: &Webview) -> RuntimeResult<()> {
    let _ = call_system_devtools(webview, "Page.crash", &json!({}));
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_platform_security_policy(webview: &Webview) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_install_security_policy(webview: *mut std::ffi::c_void) -> bool;
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let installed = unsafe { rion_wk_install_security_policy(platform_webview.inner()) };
            let _ = sender.send(installed);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err(RuntimeError::new(
            "SYSTEM_SECURITY_POLICY_FAILED",
            "WKWebView could not install the JavaScript dialog and deny-by-default permission policy.",
        )),
        Err(_) => Err(RuntimeError::new(
            "SYSTEM_SECURITY_POLICY_TIMEOUT",
            "WKWebView security policy installation timed out.",
        )),
    }
}

#[cfg(windows)]
fn install_platform_security_policy(webview: &Webview) -> RuntimeResult<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_STATE_DENY,
            COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL, ICoreWebView2, ICoreWebView2_14,
        },
        PermissionRequestedEventHandler, ServerCertificateErrorDetectedEventHandler,
    };
    use windows::core::Interface;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let permission_handler =
                PermissionRequestedEventHandler::create(Box::new(move |_webview, args| {
                    if let Some(args) = args {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                }));
            let certificate_handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(
                move |_webview, args| {
                    if let Some(args) = args {
                        args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)?;
                    }
                    Ok(())
                },
            ));
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| {
                    let mut permission_token = 0;
                    core.add_PermissionRequested(&permission_handler, &mut permission_token)?;
                    let certificate_core = core.cast::<ICoreWebView2_14>()?;
                    let mut certificate_token = 0;
                    certificate_core.add_ServerCertificateErrorDetected(
                        &certificate_handler,
                        &mut certificate_token,
                    )
                })
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SECURITY_POLICY_TIMEOUT",
                "WebView2 security policy installation timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_SECURITY_POLICY_FAILED", message))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install_platform_security_policy(_webview: &Webview) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(windows)]
fn install_process_failure_monitor(
    webview: &Webview,
    app: AppHandle,
    role_id: String,
) -> RuntimeResult<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND,
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE, ICoreWebView2,
        },
        ProcessFailedEventHandler,
    };

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let registration_sender = sender.clone();
            let event_app = app.clone();
            let event_role_id = role_id.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |_webview, args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                let kind_available =
                    args.is_some_and(|args| args.ProcessFailedKind(&mut kind).is_ok());
                if kind_available
                    && matches!(
                        kind,
                        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
                            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                    )
                    && let Some(state) = event_app.try_state::<crate::CoreState>()
                {
                    state.runtime.schedule_surface_recovery(
                        event_role_id.clone(),
                        webview2_process_failure_reason(kind).to_owned(),
                    );
                }
                Ok(())
            }));
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| {
                    let mut token = 0;
                    core.add_ProcessFailed(&handler, &mut token)
                })
                .map_err(|error| error.to_string());
            let _ = registration_sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_PROCESS_MONITOR_TIMEOUT",
                "WebView2 process-failure monitor registration timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_PROCESS_MONITOR_FAILED", message))
}

#[cfg(windows)]
fn webview2_process_failure_reason(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            "render-process-unresponsive"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render-process-exited",
        _ => "webview2-process-failed",
    }
}

#[cfg(not(windows))]
fn install_process_failure_monitor(
    _webview: &Webview,
    _app: AppHandle,
    _role_id: String,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(windows)]
fn call_system_devtools(webview: &Webview, method: &str, params: &Value) -> RuntimeResult<String> {
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::HSTRING;

    let method = HSTRING::from(method);
    let params = HSTRING::from(serde_json::to_string(params).map_err(|error| {
        RuntimeError::new("BROWSER_DEBUGGER_PARAMS_INVALID", error.to_string())
    })?);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let request_sender = sender.clone();
    webview
        .with_webview(move |platform_webview| unsafe {
            let completion_sender = request_sender.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, value| {
                    let _ = completion_sender
                        .send(status.map(|()| value).map_err(|error| error.to_string()));
                    Ok(())
                },
            ));
            let result =
                platform_webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core: ICoreWebView2| {
                        core.CallDevToolsProtocolMethod(&method, &params, &handler)
                    });
            if let Err(error) = result {
                let _ = request_sender.send(Err(error.to_string()));
            }
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| {
            RuntimeError::new(
                "BROWSER_DEBUGGER_TIMEOUT",
                "WebView2 DevTools protocol call timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("BROWSER_DEBUGGER_FAILED", message))
}

#[cfg(not(windows))]
fn call_system_devtools(
    _webview: &Webview,
    _method: &str,
    _params: &Value,
) -> RuntimeResult<String> {
    Err(RuntimeError::new(
        "BROWSER_DEBUGGER_UNAVAILABLE",
        "WKWebView does not expose a public per-session DevTools protocol.",
    ))
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
            // WKWebView has no public per-view audio mute API. WebKit's own
            // _setPageMuted: SPI uses bit zero for page audio and preserves
            // playback position, unlike setAllMediaPlaybackSuspended:.
            let mute_selector = b"_setPageMuted:\0";
            let mute_selector = sel_registerName(mute_selector.as_ptr().cast());
            let responds_selector = b"respondsToSelector:\0";
            let responds_selector = sel_registerName(responds_selector.as_ptr().cast());
            let responds: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool =
                std::mem::transmute(objc_msgSend as *const ());
            if !responds(platform_webview.inner(), responds_selector, mute_selector) {
                let _ = sender.send(false);
                return;
            }
            let send: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) =
                std::mem::transmute(objc_msgSend as *const ());
            send(
                platform_webview.inner(),
                mute_selector,
                if muted { 1 } else { 0 },
            );
            let _ = sender.send(true);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err(RuntimeError::new(
            "TAURI_AUDIO_MUTE_UNAVAILABLE",
            "This WKWebView does not expose the required audio mute capability.",
        )),
        Err(_) => Err(RuntimeError::new(
            "TAURI_AUDIO_MUTE_FAILED",
            "Audio mute timed out.",
        )),
    }
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
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| RuntimeError::new("TAURI_AUDIO_MUTE_FAILED", "Audio mute timed out."))?
        .map_err(|message| RuntimeError::new("TAURI_AUDIO_MUTE_FAILED", message))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn set_audio_muted(_webview: &Webview, _muted: bool) -> RuntimeResult<()> {
    Err(RuntimeError::new(
        "TAURI_AUDIO_MUTE_FAILED",
        "System WebView audio mute is unavailable on this platform.",
    ))
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

    fn core(error: impl std::fmt::Display) -> Self {
        Self::new("TAURI_CORE_COMMAND_FAILED", error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn runtime_tab_host_snapshot(active_tab_id: &str) -> BrowserRuntimeSnapshot {
        serde_json::from_value(json!({
            "displays": [{
                "displayId": 11,
                "activeTabId": active_tab_id,
                "tabIds": ["tab-a", "tab-b"]
            }],
            "roles": [],
            "tabs": [
                {
                    "id": "tab-a",
                    "sourceId": "role-a",
                    "name": "Role A",
                    "displayId": 11,
                    "tabType": "role",
                    "roleIds": ["role-a"],
                    "hidden": false
                },
                {
                    "id": "tab-b",
                    "sourceId": "role-b",
                    "name": "Role B",
                    "displayId": 11,
                    "tabType": "role",
                    "roleIds": ["role-b"],
                    "hidden": false
                }
            ],
            "workspaces": []
        }))
        .unwrap()
    }

    #[test]
    fn macos_and_windows_tab_activation_share_one_display_host_plan() {
        for platform in ["macos", "windows"] {
            let live = HashMap::from([("tab-a".to_owned(), 11), ("tab-b".to_owned(), 11)]);
            let plan = resolve_runtime_tab_host_plan(
                &runtime_tab_host_snapshot("tab-b"),
                &live,
                &[11],
                Some("tab-b"),
            );
            assert_eq!(
                plan.iter()
                    .map(|entry| entry.display_id)
                    .collect::<HashSet<_>>(),
                HashSet::from([11]),
                "{platform} must retain one display host"
            );
            assert_eq!(
                plan.iter().filter(|entry| entry.active).count(),
                1,
                "{platform}"
            );
            assert!(plan.iter().all(|entry| !entry.moved), "{platform}");
            assert!(
                plan.iter()
                    .find(|entry| entry.tab_id == "tab-b")
                    .unwrap()
                    .focus
            );
        }
    }

    #[test]
    fn display_host_plan_marks_only_cross_display_tabs_for_reparenting() {
        let mut snapshot = runtime_tab_host_snapshot("tab-b");
        snapshot.tabs[1].display_id = -9_007_199_254_740_991;
        snapshot.displays = vec![
            rion_core::BrowserRuntimeDisplayRecord {
                display_id: 11,
                active_tab_id: Some("tab-a".to_owned()),
                tab_ids: vec!["tab-a".to_owned()],
            },
            rion_core::BrowserRuntimeDisplayRecord {
                display_id: -9_007_199_254_740_991,
                active_tab_id: Some("tab-b".to_owned()),
                tab_ids: vec!["tab-b".to_owned()],
            },
        ];
        let live = HashMap::from([("tab-a".to_owned(), 11), ("tab-b".to_owned(), 11)]);
        let plan = resolve_runtime_tab_host_plan(
            &snapshot,
            &live,
            &[-9_007_199_254_740_991],
            Some("tab-b"),
        );
        assert!(
            !plan
                .iter()
                .find(|entry| entry.tab_id == "tab-a")
                .unwrap()
                .moved
        );
        let moved = plan.iter().find(|entry| entry.tab_id == "tab-b").unwrap();
        assert!(moved.moved);
        assert!(moved.active);
        assert!(moved.focus);
    }

    #[test]
    fn navigation_tracker_ignores_blank_pages_and_accepts_http_finish_without_started() {
        let tracker = NavigationTracker::default();
        tracker.reset();
        tracker.page_event(PageLoadEvent::Finished, &Url::parse("about:blank").unwrap());
        assert!(!tracker.state.lock().unwrap().finished);

        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/redirected").unwrap(),
        );
        assert!(tracker.state.lock().unwrap().finished);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_security_policy_installs_dialogs_and_denies_undefined_media_permissions() {
        unsafe extern "C" {
            fn rion_wk_security_policy_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_security_policy_self_test() });
    }

    #[test]
    fn role_session_identity_matches_the_core_uuid_v8_algorithm() {
        let paths = role_session_paths(Path::new("/tmp/rion"), "role-1").unwrap();
        assert_eq!(
            Uuid::from_bytes(paths.webkit_identifier).to_string(),
            "32792c51-c7ee-8dce-afb2-a97ea4a6bc46"
        );
    }

    #[test]
    fn compatibility_sessions_never_reuse_role_storage() {
        let root = Path::new("/tmp/rion");
        let role = role_session_paths(root, "game-1").unwrap();
        let first = compatibility_session_paths(root, "game-1", "2026-07-26T00:00:00Z");
        let second = compatibility_session_paths(root, "game-1", "2026-07-26T00:00:01Z");
        assert_ne!(first.webkit_identifier, role.webkit_identifier);
        assert_ne!(first.webkit_identifier, second.webkit_identifier);
        assert_ne!(first.webview2, role.webview2);
        assert_ne!(first.webview2, second.webview2);
        assert!(first.webview2.starts_with(root.join("compatibility")));
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
        let bounds = role_bounds_for_size(
            target.work_area.width as f64,
            target.work_area.height as f64,
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

    #[test]
    fn native_font_script_uses_valid_escaped_css_and_skips_default_settings() {
        let default = serde_json::from_value::<GameBrowserSettingsRecord>(json!({
            "fonts": {"mode":"default","families":{}},
            "graphics": {"mode":"automatic"},
            "browserEngine":"system",
            "macroBadgePosition":{"horizontalAlign":"center","horizontalMarginPx":8,"topPx":128},
            "workspace":{"background":"material","gap":4}
        }))
        .unwrap();
        assert!(native_font_document_start_script(&default).is_empty());

        let mut custom = default;
        custom.fonts.mode = "custom".to_owned();
        custom
            .fonts
            .families
            .insert("standard".to_owned(), "A \\\"quoted\\\" font".to_owned());
        let source = native_font_document_start_script(&custom);
        assert!(source.contains("rion-studio-native-browser-fonts"));
        assert!(source.contains("quoted"));
        assert!(!source.contains("font-family:\"A \"quoted\" font\""));
        assert!(source.contains("font-family"));
    }

    #[test]
    fn shared_macro_overlay_builds_with_the_tauri_only_bridge() {
        let source = macro_overlay_document_start_script().unwrap();
        assert!(source.contains("rion_overlay_request"));
        assert!(source.contains("rion-studio-macro-overlay-v56"));
        assert!(source.contains("const overlayCss = \"*{box-sizing:border-box"));
        assert!(!source.contains(MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_CSS_TOKEN));
        assert!(!source.contains("chrome.webview"));
        assert!(!source.contains("webkit.messageHandlers"));
    }

    #[test]
    fn webview2_key_payload_matches_chromium_input_semantics() {
        let modifiers = cdp_modifier_mask(&[
            "ControlLeft".to_owned(),
            "ShiftRight".to_owned(),
            "KeyA".to_owned(),
        ]);
        assert_eq!(modifiers, 10);
        assert_eq!(
            cdp_key_descriptor("KeyA", modifiers),
            json!({
                "code": "KeyA",
                "key": "A",
                "windowsVirtualKeyCode": 65
            })
        );
        assert_eq!(
            cdp_key_descriptor("ShiftRight", modifiers),
            json!({
                "code": "ShiftRight",
                "key": "Shift",
                "windowsVirtualKeyCode": 16,
                "location": 2
            })
        );
        assert_eq!(
            resolve_modifier_codes(
                &["primary".to_owned(), "ctrl".to_owned(), "alt".to_owned()],
                false
            )
            .unwrap(),
            vec!["ControlLeft", "AltLeft"]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_input_preserves_active_modifier_flags() {
        assert_eq!(mac_modifier_flags(&[]), 0);
        assert_eq!(mac_modifier_flags(&["ShiftLeft".to_owned()]), 1 << 17);
        assert_eq!(
            mac_modifier_flags(&[
                "ControlLeft".to_owned(),
                "AltRight".to_owned(),
                "MetaLeft".to_owned(),
            ]),
            (1 << 18) | (1 << 19) | (1 << 20)
        );
        assert_eq!(
            trusted_input_status(true, false),
            EngineCapabilityStatus::Degraded
        );
        assert_eq!(
            trusted_input_status(true, true),
            EngineCapabilityStatus::Supported
        );
        assert_eq!(
            trusted_input_status(false, true),
            EngineCapabilityStatus::Disabled
        );
        assert_eq!(
            resolve_modifier_codes(&["primary".to_owned(), "ctrl".to_owned()], true).unwrap(),
            vec!["MetaLeft", "ControlLeft"]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_input_attestation_is_bound_to_the_running_os_major() {
        match option_env!("RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR") {
            Some(_) => assert!(trusted_input_attested()),
            None => assert!(!trusted_input_attested()),
        }
    }

    #[test]
    fn surface_recovery_budget_is_bounded_and_resets_after_the_window() {
        let started = Instant::now();
        let mut budget = RecoveryBudget {
            attempts: 0,
            window_started: started,
        };
        assert!(budget.claim(started));
        assert!(budget.claim(started + Duration::from_secs(1)));
        assert!(!budget.claim(started + Duration::from_secs(2)));
        assert!(budget.claim(started + SURFACE_RECOVERY_WINDOW + Duration::from_millis(1)));
        assert_eq!(budget.attempts, 1);
    }

    #[test]
    fn click_coordinates_apply_anchor_units_and_clamp_to_viewport() {
        let viewport = ViewportSize {
            width: 1000.0,
            height: 800.0,
        };
        assert_eq!(
            resolve_click_point(Some("center"), "percent", 10.0, -25.0, viewport).unwrap(),
            ClickPoint { x: 600, y: 200 }
        );
        assert_eq!(
            resolve_click_point(Some("bottom-right"), "px", -10.0, 100.0, viewport).unwrap(),
            ClickPoint { x: 990, y: 799 }
        );
        assert_eq!(
            resolve_click_point(None, "px", -5.0, -7.0, viewport).unwrap(),
            ClickPoint { x: 0, y: 0 }
        );
    }

    #[test]
    fn viewport_parsers_accept_webview2_and_tauri_results() {
        assert_eq!(
            parse_devtools_viewport(
                r#"{"cssVisualViewport":{"clientWidth":1024,"clientHeight":768}}"#
            ),
            Some(ViewportSize {
                width: 1024.0,
                height: 768.0
            })
        );
        assert_eq!(
            parse_evaluated_viewport(r#"{"width":640,"height":480}"#),
            Some(ViewportSize {
                width: 640.0,
                height: 480.0
            })
        );
        assert!(parse_devtools_params("[]").is_err());
        assert_eq!(
            parse_devtools_params(r#"{"expression":"1+1"}"#).unwrap()["expression"],
            "1+1"
        );
    }
}
