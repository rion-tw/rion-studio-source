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
    BrowserRuntimeWindowRecord, CompatibilityCheckPlanRecord, CoreCommand, CoreEffectAction,
    CoreEffectRequest, CoreEffectResult, DisplayTargetRecord, EmbeddedKeyEffectRecord,
    EmbeddedKeyTransitionRecord, EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord,
    EmbeddedTabEffectRecord, EngineCapabilitySnapshotRecord, EngineCapabilityStatus,
    GameBrowserSettingsRecord, GameWindowPlacementRecord, GameWindowUpdateInputRecord,
    LayoutBounds, LayoutDividerInput, LayoutRect, LayoutRoleInput, ResolvedBrowserEngine,
    RuntimeRestoreSessionRecord, RuntimeRestoreTabRecord, RuntimeRestoreWindowRecord,
    SessionCookieRecord, SessionTransferPayloadRecord, StateGameWindowRecord,
    StateNormalizedRectRecord, StatePixelBoundsRecord, StateRoleRecord,
    SystemWebViewRuntimeRegistrationRecord, WorkspaceAppearanceSettingsRecord,
    WorkspaceDividerDescriptor, WorkspaceDividerResizeInput, WorkspaceDividerResizeOutput,
    WorkspaceLayoutInput, WorkspaceLayoutOutput,
};
#[cfg(any(windows, target_os = "macos"))]
use rion_core::{EmbeddedRoleViewEffectRecord, StateGameRecord};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl,
    WebviewWindowBuilder, Window,
    webview::{
        Cookie, DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder,
        cookie::{SameSite, time::OffsetDateTime},
    },
    window::WindowBuilder,
};

const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(40);
const RION_STUDIO_APP_NAME: &str = "Rion Studio";
const DIVIDER_HIT_TARGET: f64 = 10.0;
#[cfg(windows)]
const WINDOWS_TAB_STRIP_HEIGHT: f64 = 44.0;
const PLATFORM_CALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
const SURFACE_RECOVERY_LIMIT: u8 = 2;
const SURFACE_RECOVERY_WINDOW: Duration = Duration::from_secs(60);
const LOCAL_STORAGE_SYNC_MAX_BYTES: usize = 10 * 1024 * 1024;
#[cfg(any(windows, target_os = "macos"))]
const TRUSTED_INPUT_EVENT_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(target_os = "macos")]
const MACOS_KEY_DISPATCH_SETTLE_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(target_os = "macos")]
static MACOS_KEY_DISPATCH_STATE: std::sync::OnceLock<Mutex<Option<String>>> =
    std::sync::OnceLock::new();
static POPUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static DISPLAY_HOST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static ROLE_ZOOM_PERSIST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
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
const MACRO_OVERLAY_REFRESH_SOURCE: &str = "void globalThis.__rionStudioMacroOverlay?.refresh?.()";
const RUNTIME_INDICATOR_RUNTIME_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/runtimeIndicators.js");
const RUNTIME_INDICATOR_CSS: &str =
    include_str!("../../src/shared/browser-overlay/runtimeIndicators.css");
const RUNTIME_INDICATOR_CSS_TOKEN: &str = "__RION_STUDIO_RUNTIME_INDICATOR_CSS__";
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

fn native_runtime_window_title_for_platform<'a>(platform: &str, title: &'a str) -> &'a str {
    if platform == "macos" {
        RION_STUDIO_APP_NAME
    } else {
        title
    }
}

pub(crate) fn native_runtime_window_title(title: &str) -> &str {
    #[cfg(target_os = "macos")]
    const PLATFORM: &str = "macos";
    #[cfg(not(target_os = "macos"))]
    const PLATFORM: &str = "windows";
    native_runtime_window_title_for_platform(PLATFORM, title)
}

fn next_zoom_factor(current: f64, action: &str, minimum: f64, maximum: f64) -> f64 {
    let value = match action {
        "in" => current + 0.1,
        "out" => current - 0.1,
        _ => 1.0,
    };
    ((value * 100.0).round() / 100.0).clamp(minimum, maximum)
}

fn effective_zoom_factor(role_zoom_factor: f64, window_zoom_factor: f64) -> f64 {
    (role_zoom_factor * window_zoom_factor).clamp(0.25, 5.0)
}

fn take_latest_role_zoom_write(
    pending: &mut HashMap<(String, String), u64>,
    key: &(String, String),
    sequence: u64,
) -> bool {
    if pending.get(key) != Some(&sequence) {
        return false;
    }
    pending.remove(key);
    true
}

fn show_zoom_indicator(webview: &Webview, label: &str) {
    if let Ok(label) = serde_json::to_string(label) {
        let _ = webview.eval(format!("globalThis.__rionStudioZoomIndicator?.({label});"));
    }
}
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
const TAURI_MACRO_OVERLAY_BRIDGE_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/macroOverlayNativeBridge.js");

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
    local_storage_sync: Option<LocalStorageRuntimeConfig>,
    navigation: Arc<NavigationTracker>,
    rect: rion_core::StateNormalizedRectRecord,
    webview: Webview,
    zoom_factor: f64,
    zoom_mode: String,
}

#[derive(Clone)]
struct LocalStorageRuntimeConfig {
    dependent_role_ids: Vec<String>,
    keys: Vec<String>,
    origin: String,
    source_role_id: Option<String>,
    token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedLocalStorageSyncSnapshot {
    schema_version: u8,
    source_role_id: String,
    origin: String,
    entries: Vec<(String, Option<String>)>,
}

struct RuntimeTab {
    active_divider_resize: Option<ActiveDividerResize>,
    audio_muted: bool,
    dividers: Vec<RuntimeDivider>,
    window_id: String,
    roles: HashMap<String, RoleSurface>,
    workspace_id: Option<String>,
    workspace_appearance: WorkspaceAppearanceSettingsRecord,
    workspace_template: Option<String>,
}

struct RuntimeDisplayHost {
    target: EmbeddedLaunchTargetRecord,
    window: Window,
    zoom_factor: f64,
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
    window_id: String,
    focus: bool,
    moved: bool,
    tab_id: String,
}

fn resolve_runtime_tab_host_plan(
    snapshot: &BrowserRuntimeSnapshot,
    live_windows: &HashMap<String, String>,
    focus_window_ids: &[String],
    focus_tab_id: Option<&str>,
) -> Vec<RuntimeTabHostPlan> {
    let active_tabs = snapshot
        .windows
        .iter()
        .filter_map(|window| {
            window
                .active_tab_id
                .as_ref()
                .map(|tab_id| (window.window_id.as_str(), tab_id.as_str()))
        })
        .collect::<HashMap<_, _>>();
    snapshot
        .tabs
        .iter()
        .filter_map(|tab| {
            let live_window_id = live_windows.get(&tab.id)?;
            let active = !tab.hidden
                && active_tabs.get(tab.window_id.as_str()).copied() == Some(tab.id.as_str());
            Some(RuntimeTabHostPlan {
                active,
                window_id: tab.window_id.clone(),
                focus: focus_tab_id == Some(tab.id.as_str())
                    || (active && focus_window_ids.contains(&tab.window_id)),
                moved: live_window_id != &tab.window_id,
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
    pending_role_zoom_writes: HashMap<(String, String), u64>,
    pending_window_resizes: HashMap<String, (u32, u32)>,
    pending_window_close_labels: HashSet<String>,
    popup_roles: HashMap<String, String>,
    recovery_required: bool,
    recovery_budgets: HashMap<String, RecoveryBudget>,
    recovery_generations: HashMap<String, u64>,
    recovering_roles: HashSet<String>,
    role_tabs: HashMap<String, String>,
    session_import_backups: HashMap<String, NativeSessionBackup>,
    display_hosts: HashMap<String, RuntimeDisplayHost>,
    tabs: HashMap<String, RuntimeTab>,
}

#[derive(Clone)]
struct NativeSessionBackup {
    cookies: Vec<Cookie<'static>>,
    local_storage: Vec<(String, String)>,
    storage_touched: bool,
}

struct RoleSessionTransferRequest<'a> {
    role_id: &'a str,
    launch_url: &'a str,
    webview2_user_data_dir: &'a str,
    webkit_data_store_identifier: &'a str,
    replace_existing: bool,
    payload: SessionTransferPayloadRecord,
    backup_transaction_id: Option<&'a str>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionBackup {
    payload: SessionTransferPayloadRecord,
    storage_touched: bool,
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
        let additional_browser_arguments = rion_core::additional_browser_arguments(
            platform,
            "msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        )
        .join(" ");
        let runtime_indicator_script = runtime_indicator_document_start_script()?;
        let document_start_script = [
            SYSTEM_RUNTIME_INIT_SCRIPT.to_owned(),
            RUNTIME_TAB_SHORTCUT_SCRIPT.to_owned(),
            RUNTIME_AUDIO_OBSERVER_SCRIPT.to_owned(),
            runtime_indicator_script,
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
        let game_windows = core
            .invoke(CoreCommand::GameWindowsList)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                    .map_err(|error| error.to_string())
            })?;
        let dormant_windows = game_windows
            .iter()
            .filter(|window| !window.tabs.is_empty())
            .map(|window| {
                let active_source_id = window.active_tab_id.as_ref().and_then(|active_tab_id| {
                    window
                        .tabs
                        .iter()
                        .find(|tab| &tab.id == active_tab_id)
                        .map(|tab| tab.source_id.clone())
                });
                RuntimeRestoreWindowRecord {
                    id: window.id.clone(),
                    target_display: window.target_display.clone(),
                    // Visibility is runtime state and intentionally is not duplicated in
                    // the lifecycle journal. All persistent windows reopen after a clean
                    // launch, including windows that were manually hidden.
                    was_visible: true,
                    active_source_id,
                    tabs: window
                        .tabs
                        .iter()
                        .map(|tab| RuntimeRestoreTabRecord {
                            tab_type: tab.tab_type.clone(),
                            source_id: tab.source_id.clone(),
                            name: tab.name.clone(),
                            role_ids: tab.role_ids.clone(),
                            hidden: tab.hidden,
                            audio_muted: tab.audio_muted,
                        })
                        .collect(),
                }
            })
            .collect::<Vec<_>>();
        let recovery_required = !stored_restore_session.clean_exit && !dormant_windows.is_empty();
        let mut unclean_session = stored_restore_session;
        unclean_session.schema_version = 2;
        unclean_session.session_generation = unclean_session.session_generation.saturating_add(1);
        unclean_session.clean_exit = false;
        unclean_session.updated_at = chrono::Utc::now().to_rfc3339();
        unclean_session.restore_in_progress_window_ids.clear();
        unclean_session.windows.clear();
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
        let macro_input_available = available && probe.macro_input_available;
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
                trusted_input: supported_if(macro_input_available),
                background_input: supported_if(macro_input_available),
                frame_evaluation: if available {
                    EngineCapabilityStatus::Degraded
                } else {
                    EngineCapabilityStatus::Disabled
                },
                popup: degraded_if(available),
                audio_mute: supported_if(available),
                custom_fonts: degraded_if(available),
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
            let window_id = &state.tabs.get(tab_id)?.window_id;
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.window.clone())
        })
    }

    fn window_for_role(&self, role_id: &str) -> Option<Window> {
        self.state.lock().ok().and_then(|state| {
            let tab_id = state.role_tabs.get(role_id)?;
            let window_id = &state.tabs.get(tab_id)?.window_id;
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.window.clone())
        })
    }

    pub fn window_for_id(&self, window_id: &str) -> Option<Window> {
        self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.window.clone())
        })
    }

    pub fn prepare_provisional_game_window(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        title: &str,
    ) -> Result<(), String> {
        let (window, _) = self
            .ensure_display_host(target, title, false)
            .map_err(|error| error.message)?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
        window.hide().map_err(|error| error.to_string())
    }

    pub fn make_provisional_game_window_interactive(&self, window_id: &str) -> Result<(), String> {
        let window = self
            .window_for_id(window_id)
            .ok_or_else(|| "Provisional Game Window was not found.".to_owned())?;
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())
    }

    pub fn position_provisional_game_window(
        &self,
        target: &EmbeddedLaunchTargetRecord,
    ) -> Result<(), String> {
        let window = self
            .window_for_id(&target.window_id)
            .ok_or_else(|| "Provisional Game Window was not found.".to_owned())?;
        if let Ok(mut state) = self.state.lock()
            && let Some(host) = state.display_hosts.get_mut(&target.window_id)
        {
            host.target = target.clone();
        }
        window
            .set_position(LogicalPosition::new(
                target.bounds.x as f64,
                target.bounds.y as f64,
            ))
            .map_err(|error| error.to_string())
    }

    pub fn window_contains_screen_point(
        &self,
        window_id: &str,
        screen_x: f64,
        screen_y: f64,
    ) -> bool {
        let Some(window) = self.window_for_id(window_id) else {
            return false;
        };
        let Ok(position) = window.outer_position() else {
            return false;
        };
        let Ok(size) = window.outer_size() else {
            return false;
        };
        let scale = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
        let left = position.x as f64 / scale;
        let top = position.y as f64 / scale;
        let width = size.width as f64 / scale;
        let height = size.height as f64 / scale;
        screen_x >= left && screen_x < left + width && screen_y >= top && screen_y < top + height
    }

    pub fn provisionally_move_tab(
        &self,
        tab_id: &str,
        target_window_id: &str,
    ) -> Result<(), String> {
        let (source_window_id, source_window, target_window, surfaces) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "The System WebView runtime state lock was poisoned.".to_owned())?;
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
            let source_window_id = tab.window_id.clone();
            let source_window = state
                .display_hosts
                .get(&source_window_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| "Source Game Window was not found.".to_owned())?;
            let target_window = state
                .display_hosts
                .get(target_window_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| "Provisional Game Window was not found.".to_owned())?;
            let mut surfaces = tab
                .roles
                .values()
                .map(|role| role.webview.clone())
                .collect::<Vec<_>>();
            surfaces.extend(tab.dividers.iter().map(|divider| divider.webview.clone()));
            (source_window_id, source_window, target_window, surfaces)
        };
        if source_window_id == target_window_id {
            return Ok(());
        }

        let mut moved: Vec<Webview> = Vec::new();
        for surface in &surfaces {
            surface.hide().map_err(|error| error.to_string())?;
            if let Err(error) = surface.reparent(&target_window) {
                for moved_surface in moved.iter().rev() {
                    let _ = moved_surface.reparent(&source_window);
                }
                for source_surface in &surfaces {
                    let _ = source_surface.show();
                }
                return Err(error.to_string());
            }
            moved.push(surface.clone());
        }
        let source_is_empty = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "The System WebView runtime state lock was poisoned.".to_owned())?;
            state
                .tabs
                .get_mut(tab_id)
                .ok_or_else(|| "Runtime tab was not found.".to_owned())?
                .window_id = target_window_id.to_owned();
            !state
                .tabs
                .values()
                .any(|tab| tab.window_id == source_window_id)
        };
        let reveal_result = (|| {
            self.layout_runtime_tab(tab_id)
                .map_err(|error| error.message)?;
            for surface in &surfaces {
                surface.show().map_err(|error| error.to_string())?;
            }
            target_window.show().map_err(|error| error.to_string())?;
            if source_is_empty {
                source_window.hide().map_err(|error| error.to_string())?;
            }
            Ok::<(), String>(())
        })();
        if let Err(message) = reveal_result {
            for surface in &surfaces {
                let _ = surface.hide();
                let _ = surface.reparent(&source_window);
            }
            if let Ok(mut state) = self.state.lock()
                && let Some(tab) = state.tabs.get_mut(tab_id)
            {
                tab.window_id = source_window_id;
            }
            let _ = self.layout_runtime_tab(tab_id);
            for surface in &surfaces {
                let _ = surface.show();
            }
            let _ = source_window.show();
            let _ = target_window.hide();
            self.publish_projection();
            return Err(message);
        }
        self.publish_projection();
        Ok(())
    }

    pub fn cancel_provisional_tab_move(
        &self,
        tab_id: &str,
        source_window_id: &str,
        provisional_window_id: &str,
    ) -> Result<(), String> {
        let current_window_id = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.tabs.get(tab_id).map(|tab| tab.window_id.clone()));
        if current_window_id.as_deref() == Some(provisional_window_id) {
            self.provisionally_move_tab(tab_id, source_window_id)?;
        }
        if let Some(source) = self.window_for_id(source_window_id) {
            let _ = source.show();
            let _ = source.set_focus();
        }
        self.discard_provisional_game_window(provisional_window_id);
        self.publish_projection();
        Ok(())
    }

    pub fn discard_provisional_game_window(&self, window_id: &str) {
        let host = self.state.lock().ok().and_then(|mut state| {
            if state.tabs.values().any(|tab| tab.window_id == window_id) {
                return None;
            }
            let host = state.display_hosts.remove(window_id)?;
            state
                .allow_window_close_labels
                .insert(host.window.label().to_owned());
            Some(host)
        });
        if let Some(host) = host {
            let _ = host.window.close();
        }
    }

    pub fn window_id_for_label(&self, label: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label).then(|| window_id.clone())
            })
        })
    }

    #[cfg(windows)]
    pub fn tab_strip_window_for_webview(&self, webview_label: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state.display_hosts.values().find_map(|host| {
                (host.tab_strip.label() == webview_label).then(|| host.target.window_id.clone())
            })
        })
    }

    #[cfg(not(windows))]
    pub fn tab_strip_window_for_webview(&self, _webview_label: &str) -> Option<String> {
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
        let mut game_windows = self
            .core
            .invoke(CoreCommand::GameWindowsList)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                    .map_err(|error| error.to_string())
            })?;
        if let Some(game_window) = game_windows
            .iter_mut()
            .find(|window| window.tabs.iter().any(|tab| tab.id == tab_id))
        {
            if let Some(tab) = game_window.tabs.iter_mut().find(|tab| tab.id == tab_id) {
                tab.audio_muted = muted;
            }
            self.core
                .invoke(CoreCommand::GameWindowUpdate {
                    id: game_window.id.clone(),
                    input: GameWindowUpdateInputRecord {
                        tabs: Some(game_window.tabs.clone()),
                        active_tab_id: Some(game_window.active_tab_id.clone()),
                        ..GameWindowUpdateInputRecord::default()
                    },
                })
                .map_err(|error| error.to_string())?;
        }
        self.publish_projection();
        Ok(())
    }

    #[cfg(windows)]
    pub fn set_windows_toolbar_revealed(
        &self,
        window_id: &str,
        revealed: bool,
    ) -> Result<(), String> {
        let tab_ids = {
            let mut state = self.state().map_err(|error| error.message)?;
            let host = state
                .display_hosts
                .get_mut(window_id)
                .ok_or_else(|| "Runtime display host was not found".to_owned())?;
            host.toolbar_revealed = revealed;
            state
                .tabs
                .iter()
                .filter_map(|(tab_id, tab)| (tab.window_id == window_id).then_some(tab_id.clone()))
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
        _window_id: &str,
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
                tab.window_id.clone(),
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
        let focused_host = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| (host.target.window_id.clone(), host.zoom_factor))
        };
        let Some((window_id, current_zoom)) = focused_host else {
            return Ok(false);
        };
        let next_zoom = next_zoom_factor(current_zoom, action, 0.25, 5.0);
        let snapshot = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                    .map_err(|error| error.to_string())
            })?;
        let Some(tab_id) = snapshot
            .windows
            .iter()
            .find(|window| window.window_id == window_id)
            .and_then(|window| window.active_tab_id.as_deref())
        else {
            return Ok(false);
        };
        let (surfaces, visible_role_ids) = {
            let state = self.state().map_err(|error| error.message)?;
            let Some(active_tab) = state.tabs.get(tab_id) else {
                return Ok(false);
            };
            let visible_role_ids = active_tab.roles.keys().cloned().collect::<HashSet<_>>();
            let surfaces = state
                .tabs
                .values()
                .filter(|tab| tab.window_id == window_id)
                .flat_map(|tab| {
                    tab.roles.iter().map(|(role_id, surface)| {
                        (
                            role_id.clone(),
                            surface.webview.clone(),
                            effective_zoom_factor(surface.zoom_factor, next_zoom),
                        )
                    })
                })
                .collect::<Vec<_>>();
            (surfaces, visible_role_ids)
        };
        for (_, webview, zoom) in &surfaces {
            webview.set_zoom(*zoom).map_err(|error| error.to_string())?;
        }
        let popup_surfaces = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .popup_roles
                .iter()
                .filter_map(|(label, role_id)| {
                    let tab_id = state.role_tabs.get(role_id)?;
                    let tab = state.tabs.get(tab_id)?;
                    if tab.window_id != window_id {
                        return None;
                    }
                    let base = tab.roles.get(role_id)?.zoom_factor;
                    Some((label.clone(), effective_zoom_factor(base, next_zoom)))
                })
                .collect::<Vec<_>>()
        };
        for (label, zoom) in popup_surfaces {
            if let Some(webview) = self.app.get_webview(&label) {
                webview.set_zoom(zoom).map_err(|error| error.to_string())?;
            }
        }
        if let Ok(mut state) = self.state()
            && let Some(host) = state.display_hosts.get_mut(&window_id)
        {
            host.zoom_factor = next_zoom;
        }
        let label = self.window_zoom_indicator_label(next_zoom);
        for (role_id, webview, _) in surfaces {
            if visible_role_ids.contains(&role_id) {
                show_zoom_indicator(&webview, &label);
            }
        }
        Ok(true)
    }

    fn window_zoom_indicator_label(&self, zoom_factor: f64) -> String {
        let percent = (zoom_factor * 100.0).round() as u32;
        let language = self
            .language
            .lock()
            .map(|language| language.clone())
            .unwrap_or_else(|_| "en".to_owned());
        match language.as_str() {
            "zh-TW" => format!("窗口 {percent}%"),
            "zh-CN" => format!("窗口 {percent}%"),
            "ja" => format!("ウインドウ {percent}%"),
            _ => format!("Window {percent}%"),
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
                    let active = snapshot.windows.iter().any(|window| {
                        window.active_tab_id.as_deref() == Some(tab.id.as_str())
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
                        "windowId": tab.window_id,
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
                .windows
                .iter()
                .filter_map(|runtime_window| {
                    let host = state.display_hosts.get(&runtime_window.window_id)?;
                    Some((
                        host.window.label().to_owned(),
                        runtime_window.window_id.clone(),
                        host.target.display_id,
                        host.target.work_area.clone(),
                        host.window.clone(),
                        runtime_window.active_tab_id.clone(),
                        runtime_window.tab_ids.len(),
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
            .map(
                |(_label, window_id, display_id, bounds, window, tab_id, tab_count)| {
                    json!({
                        "id": window_id,
                        "windowId": window_id,
                        "displayId": display_id,
                        "bounds": bounds,
                        "visible": window.is_visible().unwrap_or(false),
                        "focused": window.is_focused().unwrap_or(false),
                        "activeTabId": tab_id,
                        "tabCount": tab_count
                    })
                },
            )
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

    pub fn recovery_required(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.recovery_required)
            .unwrap_or(false)
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
        let snapshot = self.snapshot_with_native_tab_locations(snapshot);
        #[cfg(target_os = "macos")]
        self.sync_native_tab_strip(&snapshot);
        #[cfg(windows)]
        self.sync_windows_tab_strip(&snapshot);
        let _ = self
            .app
            .emit("rion://runtime-state", self.projection(&snapshot));
    }

    fn snapshot_with_native_tab_locations(
        &self,
        mut snapshot: BrowserRuntimeSnapshot,
    ) -> BrowserRuntimeSnapshot {
        let Ok(state) = self.state.lock() else {
            return snapshot;
        };
        let native_locations = state
            .tabs
            .iter()
            .map(|(tab_id, tab)| (tab_id.as_str(), tab.window_id.as_str()))
            .collect::<HashMap<_, _>>();
        let active_tab_ids = snapshot
            .windows
            .iter()
            .filter_map(|window| window.active_tab_id.clone())
            .collect::<HashSet<_>>();
        let provisional_active_tabs = snapshot
            .tabs
            .iter()
            .filter_map(|tab| {
                let window_id = native_locations.get(tab.id.as_str())?;
                (**window_id != tab.window_id).then(|| ((*window_id).to_owned(), tab.id.clone()))
            })
            .collect::<HashMap<_, _>>();
        for tab in &mut snapshot.tabs {
            if let Some(window_id) = native_locations.get(tab.id.as_str()) {
                tab.window_id = (*window_id).to_owned();
            }
        }
        for window in &mut snapshot.windows {
            window.tab_ids.clear();
            window.active_tab_id = None;
        }
        for tab in &snapshot.tabs {
            if !snapshot
                .windows
                .iter()
                .any(|window| window.window_id == tab.window_id)
            {
                snapshot.windows.push(BrowserRuntimeWindowRecord {
                    window_id: tab.window_id.clone(),
                    active_tab_id: None,
                    tab_ids: Vec::new(),
                });
            }
            let window = snapshot
                .windows
                .iter_mut()
                .find(|window| window.window_id == tab.window_id)
                .expect("native tab window was inserted");
            window.tab_ids.push(tab.id.clone());
            if active_tab_ids.contains(&tab.id) {
                window.active_tab_id = Some(tab.id.clone());
            }
        }
        for window in &mut snapshot.windows {
            if let Some(tab_id) = provisional_active_tabs.get(&window.window_id) {
                window.active_tab_id = Some(tab_id.clone());
            }
            if window.active_tab_id.is_none() {
                window.active_tab_id = window.tab_ids.first().cloned();
            }
        }
        snapshot
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
        let _ = self.persist_game_window_placement(label);
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
        let Some((window_id, window)) = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .iter()
                .find(|(_, host)| host.window.label() == label)
                .map(|(window_id, host)| (window_id.clone(), host.window.clone()))
        }) else {
            return;
        };
        let scale_factor = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
        let width = (physical_width as f64 / scale_factor).max(1.0);
        let height = (physical_height as f64 / scale_factor).max(1.0);
        let normal_state = !window.is_maximized().unwrap_or(false)
            && !window.is_fullscreen().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false);
        if normal_state
            && let Ok(mut state) = self.state.lock()
            && let Some(host) = state.display_hosts.get_mut(&window_id)
        {
            host.target.bounds.width = width.round() as i32;
            host.target.bounds.height = height.round() as i32;
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
                        (tab.window_id == window_id).then_some(tab_id.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for tab_id in tab_ids {
            let _ = self.layout_runtime_tab(&tab_id);
        }
        self.publish_projection();
        let _ = self.persist_game_window_placement(label);
    }

    pub fn move_window(&self, label: &str, physical_x: i32, physical_y: i32) {
        // Tauri window queries can synchronously marshal to AppKit's main thread.
        // Snapshot the native window while holding the runtime lock, then release
        // the lock before making any of those calls to avoid lock inversion with
        // window callbacks handled by the main event loop.
        let Some((window_id, logical_x, logical_y, monitor_target)) = query_unlocked_snapshot(
            &self.state,
            |state| {
                state
                    .display_hosts
                    .iter()
                    .find(|(_, host)| host.window.label() == label)
                    .map(|(window_id, host)| (window_id.clone(), host.window.clone()))
            },
            |(window_id, window)| {
                if window.is_maximized().unwrap_or(false)
                    || window.is_fullscreen().unwrap_or(false)
                    || window.is_minimized().unwrap_or(false)
                {
                    return None;
                }
                let scale = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
                let (logical_x, logical_y) = logical_window_position(physical_x, physical_y, scale);
                let monitor_target = window.current_monitor().ok().flatten().map(|monitor| {
                    let scale = monitor.scale_factor();
                    let work_area = monitor.work_area();
                    (
                        super::monitor_id(&monitor),
                        StatePixelBoundsRecord {
                            x: (work_area.position.x as f64 / scale).round() as i32,
                            y: (work_area.position.y as f64 / scale).round() as i32,
                            width: (work_area.size.width as f64 / scale).round() as i32,
                            height: (work_area.size.height as f64 / scale).round() as i32,
                        },
                    )
                });
                Some((window_id, logical_x, logical_y, monitor_target))
            },
        )
        .flatten() else {
            return;
        };
        if let Ok(mut state) = self.state.lock()
            && let Some(host) = state.display_hosts.get_mut(&window_id)
        {
            host.target.bounds.x = logical_x;
            host.target.bounds.y = logical_y;
            if let Some((display_id, work_area)) = monitor_target {
                host.target.display_id = display_id;
                host.target.work_area = work_area;
            }
        }
        let _ = self.persist_game_window_placement(label);
    }

    pub fn relocate_game_window(&self, target: EmbeddedLaunchTargetRecord) -> Result<(), String> {
        let Some(window) = self.window_for_id(&target.window_id) else {
            return Ok(());
        };
        if window.is_fullscreen().unwrap_or(false) {
            window
                .set_fullscreen(false)
                .map_err(|error| error.to_string())?;
        }
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|error| error.to_string())?;
        }
        window
            .set_position(LogicalPosition::new(
                target.bounds.x as f64,
                target.bounds.y as f64,
            ))
            .map_err(|error| error.to_string())?;
        window
            .set_size(LogicalSize::new(
                target.bounds.width.max(1) as f64,
                target.bounds.height.max(1) as f64,
            ))
            .map_err(|error| error.to_string())?;
        let tab_ids = {
            let mut state = self.state().map_err(|error| error.message)?;
            if let Some(host) = state.display_hosts.get_mut(&target.window_id) {
                host.target = target.clone();
            }
            state
                .tabs
                .iter()
                .filter_map(|(tab_id, tab)| {
                    (tab.window_id == target.window_id).then_some(tab_id.clone())
                })
                .collect::<Vec<_>>()
        };
        for tab_id in tab_ids {
            self.layout_runtime_tab(&tab_id)
                .map_err(|error| error.message)?;
        }
        match target.presentation.as_str() {
            "fullscreen" => window
                .set_fullscreen(true)
                .map_err(|error| error.to_string())?,
            "maximized" => window.maximize().map_err(|error| error.to_string())?,
            _ => {}
        }
        self.publish_projection();
        Ok(())
    }

    pub fn focus_window(&self, label: &str) {
        let Some(window_id) = self.window_id_for_label(label) else {
            return;
        };
        if let Ok(mut session) = self
            .core
            .invoke(CoreCommand::RuntimeRestoreSessionGet)
            .and_then(|value| {
                serde_json::from_value::<RuntimeRestoreSessionRecord>(value)
                    .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
            })
        {
            session.last_focused_window_id = Some(window_id);
            session.updated_at = chrono::Utc::now().to_rfc3339();
            let _ = self
                .core
                .invoke(CoreCommand::RuntimeRestoreSessionReplace { session });
        }
        let _ = self.persist_game_window_placement(label);
    }

    pub fn persist_all_game_window_placements(&self) -> Result<(), String> {
        let labels = self
            .state
            .lock()
            .map(|state| {
                state
                    .display_hosts
                    .values()
                    .map(|host| host.window.label().to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for label in labels {
            self.persist_game_window_placement(&label)?;
        }
        Ok(())
    }

    fn persist_game_window_placement(&self, label: &str) -> Result<(), String> {
        let primary_id = self
            .app
            .primary_monitor()
            .ok()
            .flatten()
            .as_ref()
            .map(super::monitor_id);
        // Do not call into Tauri/AppKit while holding RuntimeState. These queries
        // may synchronously wait for the main thread, which also handles moved
        // events and needs the same mutex.
        let snapshot = query_unlocked_snapshot(
            &self.state,
            |state| {
                state
                    .display_hosts
                    .values()
                    .find(|host| host.window.label() == label)
                    .map(|host| (host.window.clone(), host.target.clone()))
            },
            |(window, target)| {
                let presentation = if window.is_fullscreen().unwrap_or(false) {
                    "fullscreen"
                } else if window.is_maximized().unwrap_or(false) {
                    "maximized"
                } else {
                    "normal"
                };
                let display_target = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .map(|monitor| super::display_target_and_work_area(&monitor, primary_id).0)
                    .unwrap_or(DisplayTargetRecord {
                        id: target.display_id,
                        fingerprint: None,
                    });
                (target, display_target, presentation.to_owned())
            },
        );
        let Some((target, display_target, presentation)) = snapshot else {
            return Ok(());
        };
        self.core
            .invoke(CoreCommand::GameWindowUpdate {
                id: target.window_id,
                input: GameWindowUpdateInputRecord {
                    target_display: Some(display_target),
                    placement: Some(GameWindowPlacementRecord {
                        normal_bounds: target.bounds,
                        saved_work_area: target.work_area,
                        presentation,
                    }),
                    ..GameWindowUpdateInputRecord::default()
                },
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
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
        let mut session = self
            .core
            .invoke(CoreCommand::RuntimeRestoreSessionGet)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<RuntimeRestoreSessionRecord>(value)
                    .map_err(|error| error.to_string())
            })?;
        session.schema_version = 2;
        session.updated_at = chrono::Utc::now().to_rfc3339();
        session.clean_exit = clean_exit;
        session.restore_in_progress_window_ids.clear();
        session.windows.clear();
        self.core
            .invoke(CoreCommand::RuntimeRestoreSessionReplace { session })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn take_macro_page_request(&self) -> Option<Value> {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_macro_page_request.take())
    }

    pub fn refresh_macro_overlays(&self, role_ids: &[String]) {
        let (mut webviews, popup_labels) = {
            let Ok(state) = self.state.lock() else {
                return;
            };
            let webviews = state
                .tabs
                .values()
                .flat_map(|tab| tab.roles.iter())
                .filter(|(role_id, _)| should_refresh_macro_overlay(role_ids, role_id))
                .map(|(_, surface)| surface.webview.clone())
                .collect::<Vec<_>>();
            let popup_labels = state
                .popup_roles
                .iter()
                .filter(|(_, role_id)| should_refresh_macro_overlay(role_ids, role_id))
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            (webviews, popup_labels)
        };

        for label in popup_labels {
            if let Some(webview) = self.app.get_webview(&label) {
                webviews.push(webview);
            }
        }
        refresh_macro_overlay_handles(webviews, |webview| {
            webview.eval(MACRO_OVERLAY_REFRESH_SOURCE)
        });
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
    pub(crate) fn role_cookie_for_attestation(
        &self,
        role_id: &str,
        url: &str,
        name: &str,
    ) -> Result<Value, String> {
        let webview = self.role_webview(role_id).map_err(|error| error.message)?;
        let url = Url::parse(url).map_err(|error| error.to_string())?;
        let cookie = cookies_for_launch(&webview, &url)
            .map_err(|error| error.message)?
            .into_iter()
            .find(|cookie| cookie.name() == name);
        Ok(cookie.map_or(Value::Null, |cookie| {
            json!({
                "domain": cookie.domain(),
                "expires": cookie.expires_datetime().map(|value| value.unix_timestamp()),
                "httpOnly": cookie.http_only(),
                "name": cookie.name(),
                "path": cookie.path(),
                "sameSite": cookie.same_site().map(|value| format!("{value:?}")),
                "secure": cookie.secure()
            })
        }))
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

    pub fn zoom_role_for_webview(
        self: &Arc<Self>,
        webview_label: &str,
        action: &str,
    ) -> Result<u32, String> {
        if !matches!(action, "in" | "out" | "reset") {
            return Err("Role zoom action is invalid.".to_owned());
        }
        let role_id = self.role_id_for_webview(webview_label)?;
        let (tab_id, workspace_id, window_zoom_factor, base_zoom_factor, webviews) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let tab_id = state
                .role_tabs
                .get(&role_id)
                .cloned()
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let tab = state
                .tabs
                .get(&tab_id)
                .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
            let surface = tab
                .roles
                .get(&role_id)
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let window_zoom_factor = state
                .display_hosts
                .get(&tab.window_id)
                .map(|host| host.zoom_factor)
                .unwrap_or(1.0);
            let mut webviews = vec![surface.webview.clone()];
            webviews.extend(
                state
                    .popup_roles
                    .iter()
                    .filter_map(|(label, popup_role_id)| {
                        (popup_role_id == &role_id)
                            .then(|| self.app.get_webview(label))
                            .flatten()
                    }),
            );
            (
                tab_id,
                tab.workspace_id.clone(),
                window_zoom_factor,
                next_zoom_factor(surface.zoom_factor, action, 0.25, 3.0),
                webviews,
            )
        };
        let effective_zoom = effective_zoom_factor(base_zoom_factor, window_zoom_factor);
        for webview in &webviews {
            webview
                .set_zoom(effective_zoom)
                .map_err(|error| error.to_string())?;
        }
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let surface = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.roles.get_mut(&role_id))
                .ok_or_else(|| "Runtime role stopped while zooming.".to_owned())?;
            surface.zoom_factor = base_zoom_factor;
            surface.zoom_mode = "fixed".to_owned();
        }
        let percent = (base_zoom_factor * 100.0).round() as u32;
        if let Some(source) = webviews
            .iter()
            .find(|webview| webview.label() == webview_label)
            .or_else(|| webviews.first())
        {
            show_zoom_indicator(source, &format!("{percent}%"));
        }
        if let Some(workspace_id) = workspace_id {
            self.schedule_role_zoom_persistence(workspace_id, role_id, percent);
        }
        Ok(percent)
    }

    fn schedule_role_zoom_persistence(
        self: &Arc<Self>,
        workspace_id: String,
        role_id: String,
        percent: u32,
    ) {
        let sequence = ROLE_ZOOM_PERSIST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let key = (workspace_id.clone(), role_id.clone());
        if let Ok(mut state) = self.state.lock() {
            state.pending_role_zoom_writes.insert(key.clone(), sequence);
        }
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let should_write = runtime.state.lock().ok().is_some_and(|mut state| {
                take_latest_role_zoom_write(&mut state.pending_role_zoom_writes, &key, sequence)
            });
            if !should_write {
                return;
            }
            if let Err(error) = runtime
                .core
                .invoke_async(CoreCommand::WorkspaceSetRoleBrowserZoom {
                    workspace_id: workspace_id.clone(),
                    role_id: role_id.clone(),
                    browser_zoom_percent: percent as f64,
                })
                .await
            {
                let _ = runtime.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "TAURI_ROLE_ZOOM_PERSIST_FAILED",
                        "message": error.to_string(),
                        "workspaceId": workspace_id,
                        "roleId": role_id,
                        "browserZoomPercent": percent
                    }),
                );
            }
        });
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

    #[cfg(target_os = "macos")]
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
        let effective_zoom = self.state.lock().ok().and_then(|mut state| {
            let tab_id = state.role_tabs.get(&role_id)?.clone();
            let tab = state.tabs.get(&tab_id)?;
            let role_zoom = tab.roles.get(&role_id)?.zoom_factor;
            let window_zoom = state
                .display_hosts
                .get(&tab.window_id)
                .map(|host| host.zoom_factor)
                .unwrap_or(1.0);
            state
                .popup_roles
                .insert(window_label.clone(), role_id.clone());
            Some(effective_zoom_factor(role_zoom, window_zoom))
        });
        if let Some(effective_zoom) = effective_zoom
            && let Some(webview) = self.app.get_webview(&window_label)
        {
            let _ = webview.set_zoom(effective_zoom);
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
        let (
            window,
            old_webview,
            rect,
            current_url,
            zoom_factor,
            zoom_mode,
            window_zoom_factor,
            audio_muted,
            generation,
        ) = {
            let mut state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found during System WebView recovery.",
                )
            })?;
            let (window_id, old_webview, rect, current_url, zoom_factor, zoom_mode, audio_muted) = {
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
                    tab.window_id.clone(),
                    role.webview.clone(),
                    role.rect.clone(),
                    current_url,
                    role.zoom_factor,
                    role.zoom_mode.clone(),
                    tab.audio_muted,
                )
            };
            let host = state.display_hosts.get(&window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found during recovery.",
                )
            })?;
            let window = host.window.clone();
            let window_zoom_factor = host.zoom_factor;
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
                zoom_mode,
                window_zoom_factor,
                audio_muted,
                *next_generation,
            )
        };
        let host_visible = window.is_visible().map_err(RuntimeError::tauri)?;
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
        if !host_visible {
            // Keep recovery in the same hidden state as the host. WebView2 can otherwise
            // treat a newly-created child as an input target during navigation even when its
            // native parent is hidden, which makes the recovery attestation report focused
            // input instead of trusted background input.
            webview.hide().map_err(RuntimeError::tauri)?;
        }
        install_platform_security_policy(&webview)?;
        install_role_zoom_shortcut_handler(&webview, self.app.clone())?;
        install_process_failure_monitor(&webview, self.app.clone(), role_id.to_owned())?;
        webview
            .set_zoom(effective_zoom_factor(zoom_factor, window_zoom_factor))
            .map_err(RuntimeError::tauri)?;
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
                    local_storage_sync: None,
                    navigation,
                    rect,
                    webview,
                    zoom_factor,
                    zoom_mode,
                },
            );
            tab_id
        };
        self.layout_runtime_tab(&tab_id)
    }

    fn apply(&self, effect: CoreEffectRequest) -> RuntimeResult<Option<String>> {
        match effect.action {
            CoreEffectAction::LocalStorageSyncRefresh {
                source_role_id,
                source_launch_url,
                origin,
                keys,
            } => {
                self.refresh_local_storage_sync_source(
                    &source_role_id,
                    &source_launch_url,
                    &origin,
                    &keys,
                )?;
                Ok(None)
            }
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
                reveal_window_ids,
                focus_window_ids,
                focus_tab_id,
            } => {
                self.apply_runtime(
                    snapshot,
                    target,
                    &reveal_window_ids,
                    &focus_window_ids,
                    focus_tab_id.as_deref(),
                )?;
                Ok(None)
            }
            CoreEffectAction::RoleBrowserDataClearSession {
                role_id,
                origin,
                local_storage_sync_keys,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => {
                self.clear_role_browser_data(
                    &role_id,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                )?;
                self.local_storage_sync_source_cleared(
                    &role_id,
                    &origin,
                    &local_storage_sync_keys,
                )?;
                Ok(None)
            }
            CoreEffectAction::LegacySessionRestore {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => {
                let payload = self.load_session_transfer(&transaction_id)?;
                let (inserted_cookie_count, _) =
                    self.apply_role_session_transfer(RoleSessionTransferRequest {
                        role_id: &role_id,
                        launch_url: &launch_url,
                        webview2_user_data_dir: &webview2_user_data_dir,
                        webkit_data_store_identifier: &webkit_data_store_identifier,
                        replace_existing: false,
                        payload,
                        backup_transaction_id: None,
                    })?;
                Ok(Some(
                    json!({ "insertedCookieCount": inserted_cookie_count }).to_string(),
                ))
            }
            CoreEffectAction::ChromeProfileImportSnapshot {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
                replace_existing,
            } => {
                self.snapshot_role_session_transfer(
                    &transaction_id,
                    &role_id,
                    &launch_url,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                    replace_existing,
                )?;
                Ok(None)
            }
            CoreEffectAction::ChromeProfileImportApply {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
                replace_existing,
            } => {
                let payload = self.load_session_transfer(&transaction_id)?;
                let (inserted_cookie_count, backup) =
                    self.apply_role_session_transfer(RoleSessionTransferRequest {
                        role_id: &role_id,
                        launch_url: &launch_url,
                        webview2_user_data_dir: &webview2_user_data_dir,
                        webkit_data_store_identifier: &webkit_data_store_identifier,
                        replace_existing,
                        payload,
                        backup_transaction_id: Some(&transaction_id),
                    })?;
                self.state()?
                    .session_import_backups
                    .insert(transaction_id, backup);
                Ok(Some(
                    json!({ "insertedCookieCount": inserted_cookie_count }).to_string(),
                ))
            }
            CoreEffectAction::ChromeProfileImportVerify {
                role_id,
                verification_url,
                authenticated_path,
                login_path,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => self.verify_role_authentication(
                &role_id,
                &verification_url,
                &authenticated_path,
                &login_path,
                &webview2_user_data_dir,
                &webkit_data_store_identifier,
            ),
            CoreEffectAction::ChromeProfileImportRollback {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => {
                self.rollback_role_session_transfer(
                    &transaction_id,
                    &role_id,
                    &launch_url,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                )?;
                Ok(None)
            }
            CoreEffectAction::ChromeProfileImportCommit { transaction_id } => {
                self.commit_role_session_transfer(&transaction_id)?;
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
                {
                    self.state()?.pending_macro_page_request = Some(request.clone());
                }
                let dispatch_app = self.app.clone();
                let window_app = dispatch_app.clone();
                dispatch_app
                    .run_on_main_thread(move || {
                        if let Some(window) = window_app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = window_app.emit("rion://macro-page-request", request);
                    })
                    .map_err(RuntimeError::tauri)?;
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
                            && let Some(window_id) = snapshot
                                .tabs
                                .iter()
                                .find(|tab| tab.role_ids.iter().any(|id| id == role_id))
                                .map(|tab| tab.window_id.clone())
                        {
                            let core = Arc::clone(&shortcut_core);
                            tauri::async_runtime::spawn(async move {
                                let _ = core
                                    .invoke_async(CoreCommand::EmbeddedTabActivateAdjacent {
                                        window_id,
                                        direction,
                                    })
                                    .await;
                            });
                        }
                    }
                    return false;
                }
                let allowed = matches!(url.scheme(), "about" | "http" | "https");
                if should_release_macros_for_navigation(url)
                    && let Some(role_id) = shortcut_role_id.as_ref()
                {
                    let core = Arc::clone(&shortcut_core);
                    let role_id = role_id.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = core
                            .invoke_async(CoreCommand::MacroReleaseRole { role_id })
                            .await;
                    });
                }
                allowed
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
                #[cfg(target_os = "macos")]
                let popup_builder =
                    popup_builder.background_throttling(BackgroundThrottlingPolicy::Throttle);
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
                        if let Err(error) =
                            install_role_zoom_shortcut_handler(window.as_ref(), popup_app.clone())
                        {
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
            #[cfg(target_os = "macos")]
            {
                // Match browser-like background tabs: keep hidden game pages throttled instead
                // of accepting WebKit's default full suspension. Role-less utility WebViews keep
                // the system default so imports and compatibility probes are not delayed.
                builder = builder.background_throttling(BackgroundThrottlingPolicy::Throttle);
            }
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

    fn apply_role_session_transfer(
        &self,
        request: RoleSessionTransferRequest<'_>,
    ) -> RuntimeResult<(u32, NativeSessionBackup)> {
        let RoleSessionTransferRequest {
            role_id,
            launch_url,
            webview2_user_data_dir,
            webkit_data_store_identifier,
            replace_existing,
            payload,
            backup_transaction_id,
        } = request;
        if self.state()?.role_tabs.contains_key(role_id) {
            return Err(RuntimeError::new(
                "ROLE_SESSION_IMPORT_IN_USE",
                "Stop the role before importing browser session data.",
            ));
        }
        let launch = checked_web_url(launch_url)?;
        let origin = launch.origin().ascii_serialization();
        let paths = effect_session_paths(webview2_user_data_dir, webkit_data_store_identifier)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;

        let (snapshot_window, snapshot_webview, snapshot_navigation) =
            self.create_session_transfer_surface(role_id, &paths, None)?;
        let existing_backup = match backup_transaction_id {
            Some(transaction_id) => self
                .state()?
                .session_import_backups
                .get(transaction_id)
                .cloned(),
            None => None,
        };
        if backup_transaction_id.is_some() && existing_backup.is_none() {
            close_hidden_surface(snapshot_window, snapshot_webview);
            return Err(RuntimeError::new(
                "SESSION_IMPORT_BACKUP_UNAVAILABLE",
                "Chrome profile import requires a verified native session snapshot.",
            ));
        }
        let (cookie_backup, storage_backup) = if let Some(backup) = existing_backup {
            (backup.cookies, backup.local_storage)
        } else {
            let cookies = cookies_for_launch(&snapshot_webview, &launch)?;
            let local_storage = if replace_existing {
                match (|| {
                    snapshot_navigation.reset();
                    snapshot_webview
                        .navigate(launch.clone())
                        .map_err(RuntimeError::tauri)?;
                    snapshot_navigation.wait().map_err(|message| {
                        RuntimeError::new("SESSION_IMPORT_SNAPSHOT_LOAD_FAILED", message)
                    })?;
                    require_exact_webview_origin(&snapshot_webview, &origin)?;
                    read_local_storage_entries(&snapshot_webview)
                })() {
                    Ok(entries) => entries,
                    Err(error) => {
                        close_hidden_surface(snapshot_window, snapshot_webview);
                        return Err(error);
                    }
                }
            } else {
                Vec::new()
            };
            (cookies, local_storage)
        };

        let existing_cookie_keys = cookie_backup
            .iter()
            .map(native_cookie_key)
            .collect::<HashSet<_>>();
        let import_cookies = payload
            .cookies
            .iter()
            .filter(|cookie| {
                replace_existing
                    || !existing_cookie_keys.contains(&transfer_cookie_key(cookie, &launch))
            })
            .map(|cookie| transfer_cookie(cookie, &launch))
            .collect::<RuntimeResult<Vec<_>>>()?;
        if let Some(transaction_id) = backup_transaction_id {
            let backup = NativeSessionBackup {
                cookies: cookie_backup.clone(),
                local_storage: storage_backup.clone(),
                storage_touched: replace_existing || !payload.local_storage.is_empty(),
            };
            self.persist_session_backup(transaction_id, &backup)?;
            self.state()?
                .session_import_backups
                .insert(transaction_id.to_owned(), backup);
        }

        let cookie_apply_result = (|| {
            if replace_existing {
                for cookie in &cookie_backup {
                    snapshot_webview
                        .delete_cookie(cookie.clone())
                        .map_err(RuntimeError::tauri)?;
                }
            }
            for cookie in &import_cookies {
                snapshot_webview
                    .set_cookie(cookie.clone())
                    .map_err(RuntimeError::tauri)?;
            }
            let readback = cookies_for_launch(&snapshot_webview, &launch)?;
            verify_cookie_readback(&import_cookies, &readback)
        })();
        if let Err(error) = cookie_apply_result {
            let rollback = restore_url_cookies(&snapshot_webview, &launch, &cookie_backup);
            close_hidden_surface(snapshot_window, snapshot_webview);
            return Err(rollback.err().unwrap_or(error));
        }
        close_hidden_surface(snapshot_window, snapshot_webview);

        let storage_required = replace_existing || !payload.local_storage.is_empty();
        if !storage_required {
            return Ok((
                import_cookies.len() as u32,
                NativeSessionBackup {
                    cookies: cookie_backup,
                    local_storage: Vec::new(),
                    storage_touched: false,
                },
            ));
        }
        let apply_script =
            local_storage_document_start_script(&origin, replace_existing, &payload.local_storage)?;
        let storage_result = (|| {
            let (window, webview, navigation) =
                self.create_session_transfer_surface(role_id, &paths, Some(&apply_script))?;
            let result = (|| {
                navigation.reset();
                webview
                    .navigate(launch.clone())
                    .map_err(RuntimeError::tauri)?;
                navigation.wait().map_err(|message| {
                    RuntimeError::new("SESSION_IMPORT_STORAGE_LOAD_FAILED", message)
                })?;
                require_exact_webview_origin(&webview, &origin)?;
                verify_local_storage_import(&webview, &payload.local_storage, replace_existing)
            })();
            close_hidden_surface(window, webview);
            result
        })();
        if let Err(error) = storage_result {
            let cookie_rollback =
                self.restore_role_session_cookies(role_id, &paths, &launch, &cookie_backup);
            let storage_rollback =
                self.restore_role_local_storage(role_id, &paths, &launch, &origin, &storage_backup);
            if let Err(rollback_error) = cookie_rollback.and(storage_rollback) {
                return Err(RuntimeError::new(
                    "SESSION_IMPORT_ROLLBACK_FAILED",
                    format!(
                        "{} Rollback failed: {}",
                        error.message, rollback_error.message
                    ),
                ));
            }
            return Err(error);
        }
        Ok((
            import_cookies.len() as u32,
            NativeSessionBackup {
                cookies: cookie_backup,
                local_storage: storage_backup,
                storage_touched: true,
            },
        ))
    }

    fn snapshot_role_session_transfer(
        &self,
        transaction_id: &str,
        role_id: &str,
        launch_url: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
        replace_existing: bool,
    ) -> RuntimeResult<()> {
        validate_transaction_id(transaction_id)?;
        if self.state()?.role_tabs.contains_key(role_id) {
            return Err(RuntimeError::new(
                "ROLE_SESSION_IMPORT_IN_USE",
                "Stop the role before importing browser session data.",
            ));
        }
        let launch = checked_web_url(launch_url)?;
        let origin = launch.origin().ascii_serialization();
        let paths = effect_session_paths(webview2_user_data_dir, webkit_data_store_identifier)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let (window, webview, navigation) =
            self.create_session_transfer_surface(role_id, &paths, None)?;
        let result = (|| {
            let cookies = cookies_for_launch(&webview, &launch)?;
            let local_storage = if replace_existing {
                navigation.reset();
                webview
                    .navigate(launch.clone())
                    .map_err(RuntimeError::tauri)?;
                navigation.wait().map_err(|message| {
                    RuntimeError::new("SESSION_IMPORT_SNAPSHOT_LOAD_FAILED", message)
                })?;
                require_exact_webview_origin(&webview, &origin)?;
                read_local_storage_entries(&webview)?
            } else {
                Vec::new()
            };
            let backup = NativeSessionBackup {
                cookies,
                local_storage,
                storage_touched: replace_existing,
            };
            self.persist_session_backup(transaction_id, &backup)?;
            self.state()?
                .session_import_backups
                .insert(transaction_id.to_owned(), backup);
            Ok(())
        })();
        close_hidden_surface(window, webview);
        result
    }

    fn verify_role_authentication(
        &self,
        role_id: &str,
        verification_url: &str,
        authenticated_path: &str,
        login_path: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
    ) -> RuntimeResult<Option<String>> {
        if self.state()?.role_tabs.contains_key(role_id) {
            return Err(RuntimeError::new(
                "ROLE_SESSION_IMPORT_IN_USE",
                "Stop the role before verifying imported browser session data.",
            ));
        }
        if !valid_auth_probe_path(authenticated_path)
            || !valid_auth_probe_path(login_path)
            || authenticated_path == login_path
        {
            return Err(RuntimeError::new(
                "SESSION_IMPORT_AUTH_PROBE_INVALID",
                "The session authentication probe paths are invalid.",
            ));
        }
        let verification = checked_web_url(verification_url)?;
        let expected_origin = verification.origin().ascii_serialization();
        let paths = effect_session_paths(webview2_user_data_dir, webkit_data_store_identifier)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let (window, webview, navigation) =
            self.create_session_transfer_surface(role_id, &paths, None)?;
        let outcome = (|| {
            navigation.reset();
            webview
                .navigate(verification)
                .map_err(RuntimeError::tauri)?;
            navigation.wait().map_err(|message| {
                RuntimeError::new("SESSION_IMPORT_AUTH_PROBE_LOAD_FAILED", message)
            })?;
            webview.url().map_err(RuntimeError::tauri)
        })();
        close_hidden_surface(window, webview);
        let (auth_state, final_path, reason_code) = match outcome {
            Ok(final_url) if final_url.origin().ascii_serialization() != expected_origin => (
                "indeterminate",
                final_url.path().to_owned(),
                Some("SESSION_IMPORT_AUTH_PROBE_ORIGIN_MISMATCH"),
            ),
            Ok(final_url) if auth_probe_path_matches(final_url.path(), authenticated_path) => {
                ("authenticated", final_url.path().to_owned(), None)
            }
            Ok(final_url) if auth_probe_path_matches(final_url.path(), login_path) => {
                ("notAuthenticated", final_url.path().to_owned(), None)
            }
            Ok(final_url) => (
                "indeterminate",
                final_url.path().to_owned(),
                Some("SESSION_IMPORT_AUTH_PROBE_UNEXPECTED_PATH"),
            ),
            Err(error) => ("indeterminate", String::new(), Some(error.code)),
        };
        Ok(Some(
            json!({
                "authState": auth_state,
                "finalPath": final_path,
                "reasonCode": reason_code,
            })
            .to_string(),
        ))
    }

    fn load_session_transfer(
        &self,
        transaction_id: &str,
    ) -> RuntimeResult<SessionTransferPayloadRecord> {
        validate_transaction_id(transaction_id)?;
        let path = self
            .user_data_dir
            .join(".session-transfers")
            .join(transaction_id)
            .join("session-transfer.enc");
        let protected = fs::read(&path).map_err(|error| {
            RuntimeError::new(
                "SESSION_IMPORT_STAGING_UNAVAILABLE",
                format!("Encrypted session-transfer staging is unavailable: {error}"),
            )
        })?;
        let plaintext = rion_platform::unprotect_session_transfer(current_platform(), &protected)
            .map_err(|error| {
            RuntimeError::new("SESSION_IMPORT_STAGING_INVALID", error.to_string())
        })?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            RuntimeError::new(
                "SESSION_IMPORT_STAGING_INVALID",
                format!("Encrypted session-transfer payload is invalid: {error}"),
            )
        })
    }

    fn persist_session_backup(
        &self,
        transaction_id: &str,
        backup: &NativeSessionBackup,
    ) -> RuntimeResult<()> {
        validate_transaction_id(transaction_id)?;
        let payload = SessionTransferPayloadRecord {
            cookies: backup.cookies.iter().map(native_cookie_record).collect(),
            local_storage: backup
                .local_storage
                .iter()
                .map(|(key, value)| rion_core::LocalStorageEntryRecord {
                    key: key.clone(),
                    value: value.clone(),
                })
                .collect(),
        };
        let serialized = serde_json::to_vec(&PersistedSessionBackup {
            payload,
            storage_touched: backup.storage_touched,
        })
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string()))?;
        let platform = current_platform();
        let protected =
            rion_platform::protect_session_transfer(platform, &serialized).map_err(|error| {
                RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string())
            })?;
        let directory = self
            .user_data_dir
            .join(".session-transfers")
            .join(transaction_id);
        write_private_file(&directory, "backup.enc", &protected)
    }

    fn load_session_backup(
        &self,
        transaction_id: &str,
        launch: &Url,
    ) -> RuntimeResult<NativeSessionBackup> {
        validate_transaction_id(transaction_id)?;
        let protected = fs::read(
            self.user_data_dir
                .join(".session-transfers")
                .join(transaction_id)
                .join("backup.enc"),
        )
        .map_err(|error| {
            RuntimeError::new(
                "SESSION_IMPORT_ROLLBACK_UNAVAILABLE",
                format!("Encrypted session backup is unavailable: {error}"),
            )
        })?;
        let plaintext = rion_platform::unprotect_session_transfer(current_platform(), &protected)
            .map_err(|error| {
            RuntimeError::new("SESSION_IMPORT_ROLLBACK_INVALID", error.to_string())
        })?;
        let persisted: PersistedSessionBackup =
            serde_json::from_slice(&plaintext).map_err(|error| {
                RuntimeError::new("SESSION_IMPORT_ROLLBACK_INVALID", error.to_string())
            })?;
        Ok(NativeSessionBackup {
            cookies: persisted
                .payload
                .cookies
                .iter()
                .map(|cookie| transfer_cookie(cookie, launch))
                .collect::<RuntimeResult<Vec<_>>>()?,
            local_storage: persisted
                .payload
                .local_storage
                .into_iter()
                .map(|entry| (entry.key, entry.value))
                .collect(),
            storage_touched: persisted.storage_touched,
        })
    }

    fn commit_role_session_transfer(&self, transaction_id: &str) -> RuntimeResult<()> {
        validate_transaction_id(transaction_id)?;
        let directory = self
            .user_data_dir
            .join(".session-transfers")
            .join(transaction_id);
        // Publish the durable commit marker before releasing either backup. If
        // marker creation fails, the caller can still restore the exact prior
        // session and the operation journal remains authoritative.
        write_private_file(&directory, "committed", b"1")?;
        self.state()?.session_import_backups.remove(transaction_id);
        Ok(())
    }

    fn rollback_role_session_transfer(
        &self,
        transaction_id: &str,
        role_id: &str,
        launch_url: &str,
        webview2_user_data_dir: &str,
        webkit_data_store_identifier: &str,
    ) -> RuntimeResult<()> {
        validate_transaction_id(transaction_id)?;
        let launch = checked_web_url(launch_url)?;
        let backup = match self.state()?.session_import_backups.remove(transaction_id) {
            Some(backup) => backup,
            None => self.load_session_backup(transaction_id, &launch)?,
        };
        let origin = launch.origin().ascii_serialization();
        let paths = effect_session_paths(webview2_user_data_dir, webkit_data_store_identifier)?;
        self.restore_role_session_cookies(role_id, &paths, &launch, &backup.cookies)?;
        if backup.storage_touched {
            self.restore_role_local_storage(
                role_id,
                &paths,
                &launch,
                &origin,
                &backup.local_storage,
            )?;
        }
        Ok(())
    }

    fn create_session_transfer_surface(
        &self,
        role_id: &str,
        paths: &SessionPaths,
        document_start_script: Option<&str>,
    ) -> RuntimeResult<(Window, Webview, Arc<NavigationTracker>)> {
        let sequence = POPUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let suffix = format!("{role_id}:{sequence}");
        let window =
            WindowBuilder::new(&self.app, runtime_label("session-transfer-window", &suffix))
                .inner_size(1.0, 1.0)
                .visible(false)
                .build()
                .map_err(RuntimeError::tauri)?;
        let navigation = Arc::new(NavigationTracker::default());
        let callback_navigation = Arc::clone(&navigation);
        let mut builder = self
            .webview_builder(
                runtime_label("session-transfer-webview", &suffix),
                paths,
                None,
            )?
            .on_page_load(move |_webview, payload| {
                callback_navigation.page_event(payload.event(), payload.url());
            });
        if let Some(script) = document_start_script {
            builder = builder.initialization_script_for_all_frames(script);
        }
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )
            .map_err(|error| {
                let _ = window.close();
                RuntimeError::tauri(error)
            })?;
        if let Err(error) = install_platform_security_policy(&webview) {
            close_hidden_surface(window, webview);
            return Err(error);
        }
        Ok((window, webview, navigation))
    }

    fn restore_role_session_cookies(
        &self,
        role_id: &str,
        paths: &SessionPaths,
        launch: &Url,
        backup: &[Cookie<'static>],
    ) -> RuntimeResult<()> {
        let (window, webview, _) = self.create_session_transfer_surface(role_id, paths, None)?;
        let result = restore_url_cookies(&webview, launch, backup);
        close_hidden_surface(window, webview);
        result
    }

    fn restore_role_local_storage(
        &self,
        role_id: &str,
        paths: &SessionPaths,
        launch: &Url,
        origin: &str,
        backup: &[(String, String)],
    ) -> RuntimeResult<()> {
        let script = local_storage_restore_script(origin, backup)?;
        let (window, webview, navigation) =
            self.create_session_transfer_surface(role_id, paths, Some(&script))?;
        let result = (|| {
            navigation.reset();
            webview
                .navigate(launch.clone())
                .map_err(RuntimeError::tauri)?;
            navigation.wait().map_err(|message| {
                RuntimeError::new("SESSION_IMPORT_ROLLBACK_LOAD_FAILED", message)
            })?;
            require_exact_webview_origin(&webview, origin)?;
            verify_local_storage_snapshot(&webview, backup)
        })();
        close_hidden_surface(window, webview);
        result
    }

    fn create_compatibility_surface(
        &self,
        plan: CompatibilityCheckPlanRecord,
    ) -> RuntimeResult<()> {
        {
            let state = self.state()?;
            if state.compatibility.contains_key(&plan.game_id) {
                return Err(RuntimeError::new(
                    "COMPATIBILITY_RUN_ALREADY_ACTIVE",
                    "A compatibility surface already exists for this game.",
                ));
            }
        }
        let runtime_scope = format!("{}:{}", plan.game_id, plan.started_at);
        let window = WindowBuilder::new(
            &self.app,
            runtime_label("compatibility-window", &runtime_scope),
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
        if let Err(error) = fs::create_dir_all(&paths.webview2) {
            let _ = window.close();
            return Err(RuntimeError::io(error));
        }
        let builder = match self.webview_builder(
            runtime_label("compatibility-webview", &runtime_scope),
            &paths,
            None,
        ) {
            Ok(builder) => builder
                .incognito(true)
                .on_page_load(move |_webview, payload| {
                    callback_navigation.page_event(payload.event(), payload.url());
                }),
            Err(error) => {
                let _ = window.close();
                if let Some(directory) = paths.webview2.parent() {
                    let _ = fs::remove_dir_all(directory);
                }
                return Err(error);
            }
        };
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(960.0, 640.0),
            )
            .map_err(|error| {
                let _ = window.close();
                if let Some(directory) = paths.webview2.parent() {
                    let _ = fs::remove_dir_all(directory);
                }
                RuntimeError::tauri(error)
            })?;
        if let Err(error) = install_platform_security_policy(&webview) {
            let _ = webview.close();
            let _ = window.close();
            if let Some(directory) = paths.webview2.parent() {
                let _ = fs::remove_dir_all(directory);
            }
            return Err(error);
        }
        let mut state = match self.state() {
            Ok(state) => state,
            Err(error) => {
                let _ = webview.close();
                let _ = window.close();
                if let Some(directory) = paths.webview2.parent() {
                    let _ = fs::remove_dir_all(directory);
                }
                return Err(error);
            }
        };
        if state.compatibility.contains_key(&plan.game_id) {
            drop(state);
            let _ = webview.close();
            let _ = window.close();
            if let Some(directory) = paths.webview2.parent() {
                let _ = fs::remove_dir_all(directory);
            }
            return Err(RuntimeError::new(
                "COMPATIBILITY_RUN_ALREADY_ACTIVE",
                "A compatibility surface was created concurrently for this game.",
            ));
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

    fn refresh_local_storage_sync_source(
        &self,
        source_role_id: &str,
        source_launch_url: &str,
        origin: &str,
        keys: &[String],
    ) -> RuntimeResult<()> {
        validate_local_storage_sync_contract(origin, keys)?;
        let live = {
            let state = self.state()?;
            state
                .role_tabs
                .get(source_role_id)
                .and_then(|tab_id| state.tabs.get(tab_id))
                .and_then(|tab| tab.roles.get(source_role_id))
                .map(|surface| surface.webview.clone())
        };
        let entries = if let Some(webview) = live {
            require_exact_local_storage_sync_origin(&webview, origin)?;
            read_scoped_local_storage_entries(&webview, keys)?
        } else if let Ok(snapshot) =
            self.load_local_storage_sync_snapshot(source_role_id, origin, keys)
        {
            // A stopped source may still have a native storage write in flight. The
            // encrypted observer snapshot is updated before dependents are allowed
            // to observe a value, so prefer it over rereading the just-closed store.
            snapshot.entries
        } else {
            let launch = checked_web_url(source_launch_url)?;
            if launch.origin().ascii_serialization() != origin {
                return Err(RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_ORIGIN_MISMATCH",
                    "The localStorage source launch origin changed.",
                ));
            }
            let paths = role_session_paths(&self.user_data_dir, source_role_id)?;
            fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
            let (window, webview, navigation) =
                self.create_session_transfer_surface(source_role_id, &paths, None)?;
            let result = (|| {
                navigation.reset();
                webview.navigate(launch).map_err(RuntimeError::tauri)?;
                navigation.wait().map_err(|message| {
                    RuntimeError::new("LOCAL_STORAGE_SYNC_SNAPSHOT_LOAD_FAILED", message)
                })?;
                require_exact_local_storage_sync_origin(&webview, origin)?;
                read_scoped_local_storage_entries(&webview, keys)
            })();
            close_hidden_surface(window, webview);
            result?
        };
        self.persist_local_storage_sync_snapshot(PersistedLocalStorageSyncSnapshot {
            schema_version: 1,
            source_role_id: source_role_id.to_owned(),
            origin: origin.to_owned(),
            entries,
        })
    }

    fn persist_local_storage_sync_snapshot(
        &self,
        snapshot: PersistedLocalStorageSyncSnapshot,
    ) -> RuntimeResult<()> {
        let serialized = serde_json::to_vec(&snapshot).map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_INVALID",
                "The localStorage synchronization snapshot could not be encoded.",
            )
        })?;
        if serialized.len() > LOCAL_STORAGE_SYNC_MAX_BYTES {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_TOO_LARGE",
                "The localStorage synchronization snapshot exceeds 10 MiB.",
            ));
        }
        role_session_paths(&self.user_data_dir, &snapshot.source_role_id)?;
        let protected = rion_platform::protect_local_storage_sync(current_platform(), &serialized)
            .map_err(|error| {
                RuntimeError::new("LOCAL_STORAGE_SYNC_CACHE_PROTECT_FAILED", error.to_string())
            })?;
        let directory = self
            .user_data_dir
            .join("roles")
            .join(&snapshot.source_role_id)
            .join("browser")
            .join("system");
        fs::create_dir_all(&directory).map_err(RuntimeError::io)?;
        rion_platform::restrict_directory_to_current_user(&directory).map_err(|error| {
            RuntimeError::new("LOCAL_STORAGE_SYNC_CACHE_WRITE_FAILED", error.to_string())
        })?;
        let temporary = directory.join(format!(".local-storage-sync-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, protected).map_err(RuntimeError::io)?;
        let destination = directory.join("local-storage-sync-v1.enc");
        if let Err(error) = rion_platform::atomic_replace_file(&temporary, &destination) {
            let _ = fs::remove_file(&temporary);
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_WRITE_FAILED",
                error.to_string(),
            ));
        }
        Ok(())
    }

    fn load_local_storage_sync_snapshot(
        &self,
        source_role_id: &str,
        origin: &str,
        keys: &[String],
    ) -> RuntimeResult<PersistedLocalStorageSyncSnapshot> {
        validate_local_storage_sync_contract(origin, keys)?;
        role_session_paths(&self.user_data_dir, source_role_id)?;
        let path = self
            .user_data_dir
            .join("roles")
            .join(source_role_id)
            .join("browser")
            .join("system")
            .join("local-storage-sync-v1.enc");
        let protected = fs::read(path).map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_UNAVAILABLE",
                "The encrypted localStorage synchronization snapshot is unavailable.",
            )
        })?;
        let plaintext = rion_platform::unprotect_local_storage_sync(current_platform(), &protected)
            .map_err(|_| {
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_CACHE_INVALID",
                    "The encrypted localStorage synchronization snapshot is invalid.",
                )
            })?;
        if plaintext.len() > LOCAL_STORAGE_SYNC_MAX_BYTES {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_TOO_LARGE",
                "The localStorage synchronization snapshot exceeds 10 MiB.",
            ));
        }
        let snapshot: PersistedLocalStorageSyncSnapshot = serde_json::from_slice(&plaintext)
            .map_err(|_| {
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_CACHE_INVALID",
                    "The encrypted localStorage synchronization snapshot is invalid.",
                )
            })?;
        let snapshot_keys = snapshot
            .entries
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>();
        if snapshot.schema_version != 1
            || snapshot.source_role_id != source_role_id
            || snapshot.origin != origin
            || snapshot_keys != keys.iter().map(String::as_str).collect::<Vec<_>>()
        {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_CACHE_INVALID",
                "The encrypted localStorage synchronization snapshot does not match its binding.",
            ));
        }
        Ok(snapshot)
    }

    pub fn local_storage_sync_changed(
        &self,
        webview_label: &str,
        token: &str,
        entries: Vec<(String, Option<String>)>,
    ) -> Result<(), String> {
        let role_id = self.role_id_for_webview(webview_label)?;
        let (config, webview) = {
            let state = self.state().map_err(|error| error.message)?;
            let tab_id = state
                .role_tabs
                .get(&role_id)
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let surface = state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(&role_id))
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let config = surface.local_storage_sync.clone().ok_or_else(|| {
                "This role has no localStorage synchronization capability.".to_owned()
            })?;
            (config, surface.webview.clone())
        };
        if config.token != token {
            return Err("The localStorage synchronization capability is invalid.".to_owned());
        }
        require_exact_local_storage_sync_origin(&webview, &config.origin)
            .map_err(|error| error.message)?;
        if entries.len() != config.keys.len()
            || entries
                .iter()
                .zip(&config.keys)
                .any(|((key, _), expected)| key != expected)
        {
            return Err("The localStorage synchronization key set is invalid.".to_owned());
        }
        if let Some(source_role_id) = config.source_role_id.as_deref() {
            let snapshot = self
                .load_local_storage_sync_snapshot(source_role_id, &config.origin, &config.keys)
                .map_err(|error| error.message)?;
            webview
                .eval(local_storage_sync_apply_script(&snapshot).map_err(|error| error.message)?)
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
        if config.dependent_role_ids.is_empty() {
            return Ok(());
        }
        let snapshot = PersistedLocalStorageSyncSnapshot {
            schema_version: 1,
            source_role_id: role_id.clone(),
            origin: config.origin.clone(),
            entries,
        };
        self.persist_local_storage_sync_snapshot(snapshot.clone())
            .map_err(|error| error.message)?;
        self.apply_local_storage_sync_to_running_dependents(&role_id, &snapshot)
            .map_err(|error| error.message)
    }

    pub fn refresh_local_storage_sync_metadata(
        &self,
        roles: &[StateRoleRecord],
        games: &[StateGameRecord],
    ) -> Result<(), String> {
        let roles_by_id = roles
            .iter()
            .map(|role| (role.id.as_str(), role))
            .collect::<HashMap<_, _>>();
        let games_by_id = games
            .iter()
            .map(|game| (game.id.as_str(), game))
            .collect::<HashMap<_, _>>();
        let mut updates = Vec::new();
        {
            let mut state = self.state().map_err(|error| error.message)?;
            for tab in state.tabs.values_mut() {
                for (role_id, surface) in &mut tab.roles {
                    let old_source = surface
                        .local_storage_sync
                        .as_ref()
                        .and_then(|config| config.source_role_id.clone());
                    let next = roles_by_id.get(role_id.as_str()).and_then(|role| {
                        let game = games_by_id.get(role.game_id.as_str())?;
                        if game.local_storage_sync_keys.is_empty() {
                            return None;
                        }
                        let origin = checked_web_url(&role.launch_url)
                            .ok()?
                            .origin()
                            .ascii_serialization();
                        let token = surface
                            .local_storage_sync
                            .as_ref()
                            .map(|config| config.token.clone())
                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        Some(LocalStorageRuntimeConfig {
                            dependent_role_ids: roles
                                .iter()
                                .filter(|candidate| {
                                    candidate.local_storage_source_role_id.as_deref()
                                        == Some(role.id.as_str())
                                })
                                .map(|candidate| candidate.id.clone())
                                .collect(),
                            keys: game.local_storage_sync_keys.clone(),
                            origin,
                            source_role_id: role.local_storage_source_role_id.clone(),
                            token,
                        })
                    });
                    surface.local_storage_sync = next.clone();
                    if let Some(config) = next {
                        updates.push((
                            surface.webview.clone(),
                            config.clone(),
                            old_source != config.source_role_id,
                        ));
                    }
                }
            }
        }
        for (webview, config, source_changed) in updates {
            let observer =
                local_storage_sync_observer_script(&config).map_err(|error| error.message)?;
            let configuration = json!({
                "token": config.token,
                "origin": config.origin,
                "keys": config.keys,
            });
            webview
                .eval(format!(
                    "{observer}\nglobalThis.__rionLocalStorageSyncObserver?.configure?.({configuration});"
                ))
                .map_err(|error| error.to_string())?;
            if source_changed && let Some(source_role_id) = config.source_role_id.as_deref() {
                let snapshot = self
                    .load_local_storage_sync_snapshot(source_role_id, &config.origin, &config.keys)
                    .map_err(|error| error.message)?;
                require_exact_local_storage_sync_origin(&webview, &config.origin)
                    .map_err(|error| error.message)?;
                webview
                    .eval(
                        local_storage_sync_apply_script(&snapshot)
                            .map_err(|error| error.message)?,
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn apply_local_storage_sync_to_running_dependents(
        &self,
        source_role_id: &str,
        snapshot: &PersistedLocalStorageSyncSnapshot,
    ) -> RuntimeResult<()> {
        let targets = {
            let state = self.state()?;
            state
                .tabs
                .values()
                .flat_map(|tab| tab.roles.values())
                .filter_map(|surface| {
                    let config = surface.local_storage_sync.as_ref()?;
                    (config.source_role_id.as_deref() == Some(source_role_id)
                        && config.origin == snapshot.origin)
                        .then(|| (surface.webview.clone(), config.origin.clone()))
                })
                .collect::<Vec<_>>()
        };
        let script = local_storage_sync_apply_script(snapshot)?;
        let mut first_error = None;
        for (webview, origin) in targets {
            let result = require_exact_local_storage_sync_origin(&webview, &origin)
                .and_then(|()| webview.eval(&script).map_err(RuntimeError::tauri));
            if first_error.is_none()
                && let Err(error) = result
            {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn local_storage_sync_source_cleared(
        &self,
        source_role_id: &str,
        origin: &str,
        keys: &[String],
    ) -> RuntimeResult<()> {
        if keys.is_empty() {
            return Ok(());
        }
        validate_local_storage_sync_contract(origin, keys)?;
        let snapshot = PersistedLocalStorageSyncSnapshot {
            schema_version: 1,
            source_role_id: source_role_id.to_owned(),
            origin: origin.to_owned(),
            entries: keys.iter().map(|key| (key.clone(), None)).collect(),
        };
        self.persist_local_storage_sync_snapshot(snapshot.clone())?;
        self.apply_local_storage_sync_to_running_dependents(source_role_id, &snapshot)
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
        let (
            window,
            role_views,
            divider_views,
            gap,
            window_zoom_factor,
            tab_strip,
            _toolbar_revealed,
        ) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let host = state.display_hosts.get(&tab.window_id).ok_or_else(|| {
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
                            surface.zoom_factor,
                            surface.zoom_mode.clone(),
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
                host.zoom_factor,
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
            .map(|(_, _, _, _, input)| input.clone())
            .collect();
        let (role_bounds, divider_bounds) =
            self.resolve_runtime_layout(metrics, role_inputs, gap)?;
        let mut zoom_updates = Vec::with_capacity(role_views.len());
        for (role_id, webview, current_zoom, zoom_mode, _) in &role_views {
            let Some(bounds) = role_bounds.get(role_id) else {
                continue;
            };
            let base_zoom = if zoom_mode == "adaptive" {
                self.adaptive_zoom_factor(bounds.width, Some(*current_zoom))?
            } else {
                *current_zoom
            };
            zoom_updates.push((
                role_id.clone(),
                webview.clone(),
                base_zoom,
                effective_zoom_factor(base_zoom, window_zoom_factor),
            ));
        }
        for (role_id, webview, _, _, _) in role_views {
            if let Some(bounds) = role_bounds.get(&role_id) {
                webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .map_err(RuntimeError::tauri)?;
                webview
                    .set_size(LogicalSize::new(bounds.width, bounds.height))
                    .map_err(RuntimeError::tauri)?;
            }
        }
        for (_, webview, _, effective_zoom) in &zoom_updates {
            webview
                .set_zoom(*effective_zoom)
                .map_err(RuntimeError::tauri)?;
        }
        let popup_updates = {
            let state = self.state()?;
            state
                .popup_roles
                .iter()
                .filter_map(|(label, popup_role_id)| {
                    zoom_updates
                        .iter()
                        .find(|(role_id, _, _, _)| role_id == popup_role_id)
                        .map(|(_, _, _, effective)| (label.clone(), *effective))
                })
                .collect::<Vec<_>>()
        };
        for (label, effective_zoom) in popup_updates {
            if let Some(webview) = self.app.get_webview(&label) {
                webview
                    .set_zoom(effective_zoom)
                    .map_err(RuntimeError::tauri)?;
            }
        }
        if let Ok(mut state) = self.state()
            && let Some(tab) = state.tabs.get_mut(tab_id)
        {
            for (role_id, _, base_zoom, _) in zoom_updates {
                if let Some(surface) = tab.roles.get_mut(&role_id)
                    && surface.zoom_mode == "adaptive"
                {
                    surface.zoom_factor = base_zoom;
                }
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

    fn adaptive_zoom_factor(
        &self,
        viewport_width: f64,
        current_factor: Option<f64>,
    ) -> RuntimeResult<f64> {
        let value = self
            .core
            .invoke(CoreCommand::LayoutAdaptiveZoom {
                viewport_width,
                current_percent: current_factor.map(|factor| (factor * 100.0).round() as u32),
            })
            .map_err(RuntimeError::core)?;
        value
            .as_u64()
            .map(|percent| percent as f64 / 100.0)
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_LAYOUT_INVALID",
                    "Adaptive role zoom did not return a percentage.",
                )
            })
    }

    fn ensure_display_host(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        title: &str,
        reveal_for_initialization: bool,
    ) -> RuntimeResult<(Window, bool)> {
        if let Some(window) = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| host.window.clone())
        {
            return Ok((window, false));
        }

        // Tauri unregisters a closed native window asynchronously. A fresh generation keeps a
        // display that loses its final tab from colliding with that retiring window while still
        // preserving one stable host for the full lifetime of the next tab group.
        let host_generation = DISPLAY_HOST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let host_id = format!("{}:{host_generation}", target.window_id);
        let window_label = runtime_label("game-display", &host_id);
        let window = WindowBuilder::new(&self.app, window_label)
            .title(native_runtime_window_title(title))
            .position(target.bounds.x as f64, target.bounds.y as f64)
            .inner_size(
                target.bounds.width.max(1) as f64,
                target.bounds.height.max(1) as f64,
            )
            .min_inner_size(640.0, 480.0)
            .visible(false)
            .build()
            .map_err(RuntimeError::tauri)?;
        #[cfg(windows)]
        if reveal_for_initialization {
            // WebView2 can wait indefinitely while creating a child inside a hidden
            // native window on the hosted runner. The attestation hides the host
            // again before returning, so this only warms the test fixture's native
            // surfaces and does not alter normal runtime launch visibility.
            window.show().map_err(RuntimeError::tauri)?;
        }
        #[cfg(not(windows))]
        let _ = reveal_for_initialization;
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
            LogicalSize::new(target.bounds.width.max(1) as f64, WINDOWS_TAB_STRIP_HEIGHT),
        ) {
            Ok(tab_strip) => tab_strip,
            Err(error) => {
                let _ = window.close();
                return Err(RuntimeError::tauri(error));
            }
        };

        let mut state = self.state()?;
        if let Some(existing) = state.display_hosts.get(&target.window_id) {
            let existing = existing.window.clone();
            drop(state);
            let _ = window.close();
            return Ok((existing, false));
        }
        state.display_hosts.insert(
            target.window_id.clone(),
            RuntimeDisplayHost {
                target: target.clone(),
                window: window.clone(),
                zoom_factor: 1.0,
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

    fn remove_empty_display_host(&self, window_id: &str, created_for_operation: bool) {
        if !created_for_operation {
            return;
        }
        let host = self.state.lock().ok().and_then(|mut state| {
            let has_tabs = state.tabs.values().any(|tab| tab.window_id == window_id);
            if has_tabs {
                return None;
            }
            let host = state.display_hosts.remove(window_id)?;
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
        let mut refreshed_sources = HashSet::new();
        for role in &tab.roles {
            if let Some(source) = role
                .local_storage_sync
                .as_ref()
                .and_then(|sync| sync.source.as_ref())
                && refreshed_sources.insert(source.role_id.clone())
            {
                self.refresh_local_storage_sync_source(
                    &source.role_id,
                    &source.launch_url,
                    &role
                        .local_storage_sync
                        .as_ref()
                        .expect("checked above")
                        .origin,
                    &role
                        .local_storage_sync
                        .as_ref()
                        .expect("checked above")
                        .keys,
                )?;
            }
        }
        let target = tab.target.clone();
        let reveal_for_initialization = tab.tab_id.starts_with("attestation-tab-");
        let (window, host_created) =
            self.ensure_display_host(&target, &tab.name, reveal_for_initialization)?;
        let window_zoom_factor = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| host.zoom_factor)
            .unwrap_or(1.0);
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
                let sync_config =
                    role.local_storage_sync
                        .as_ref()
                        .map(|sync| LocalStorageRuntimeConfig {
                            dependent_role_ids: sync.dependent_role_ids.clone(),
                            keys: sync.keys.clone(),
                            origin: sync.origin.clone(),
                            source_role_id: sync
                                .source
                                .as_ref()
                                .map(|source| source.role_id.clone()),
                            token: uuid::Uuid::new_v4().to_string(),
                        });
                let navigation = Arc::new(NavigationTracker::default());
                let callback_navigation = Arc::clone(&navigation);
                let role_label = runtime_label("game-role", &role_id);
                let paths = role_session_paths(&self.user_data_dir, &role_id)?;
                fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
                let mut builder = self
                    .webview_builder(role_label, &paths, Some(&role_id))?
                    .on_page_load(move |_webview, payload| {
                        callback_navigation.page_event(payload.event(), payload.url());
                    });
                if let Some(config) = sync_config.as_ref() {
                    builder = builder.initialization_script_for_all_frames(
                        &local_storage_sync_observer_script(config)?,
                    );
                    if let Some(source_role_id) = config.source_role_id.as_deref() {
                        let snapshot = self.load_local_storage_sync_snapshot(
                            source_role_id,
                            &config.origin,
                            &config.keys,
                        )?;
                        builder = builder.initialization_script_for_all_frames(
                            &local_storage_sync_apply_script(&snapshot)?,
                        );
                    }
                }
                let bounds = resolved_role_bounds
                    .get(&role_id)
                    .copied()
                    .unwrap_or_else(|| role_bounds_for_content(content_metrics, &role.rect));
                let base_zoom_factor = if role.zoom_mode == "adaptive" {
                    self.adaptive_zoom_factor(bounds.width, None)?
                } else {
                    role.zoom_factor.clamp(0.25, 3.0)
                };
                let webview = window
                    .add_child(
                        builder,
                        LogicalPosition::new(bounds.x, bounds.y),
                        LogicalSize::new(bounds.width, bounds.height),
                    )
                    .map_err(RuntimeError::tauri)?;
                created_webviews.push(webview.clone());
                install_platform_security_policy(&webview)
                    .and_then(|()| install_role_zoom_shortcut_handler(&webview, self.app.clone()))
                    .and_then(|()| {
                        install_process_failure_monitor(&webview, self.app.clone(), role_id.clone())
                    })
                    .and_then(|()| {
                        webview
                            .set_zoom(effective_zoom_factor(base_zoom_factor, window_zoom_factor))
                            .map_err(RuntimeError::tauri)
                    })?;
                webview.hide().map_err(RuntimeError::tauri)?;
                role_ids.push(role_id.clone());
                surfaces.insert(
                    role_id,
                    RoleSurface {
                        current_url: None,
                        local_storage_sync: sync_config,
                        navigation,
                        rect: role.rect.clone(),
                        webview,
                        zoom_factor: base_zoom_factor,
                        zoom_mode: role.zoom_mode.clone(),
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
                    window_id: target.window_id.clone(),
                    roles: surfaces,
                    workspace_id: tab.workspace_id,
                    workspace_appearance: tab.workspace_appearance,
                    workspace_template: tab.workspace_template,
                },
            );
            #[cfg(windows)]
            if reveal_for_initialization && host_created {
                window.hide().map_err(RuntimeError::tauri)?;
            }
            Ok(())
        })();
        if result.is_err() {
            for webview in created_webviews {
                let _ = webview.close();
            }
            self.remove_empty_display_host(&target.window_id, host_created);
        }
        result
    }

    fn load_roles(&self, roles: Vec<EmbeddedRoleLoadEffectRecord>) -> RuntimeResult<()> {
        let mut pending_navigations = Vec::with_capacity(roles.len());
        let restore_attestation =
            std::env::var_os("RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_OUTPUT").is_some();

        for role in roles {
            if !is_current_system_engine(role.resolved_engine) {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_ENGINE_MISMATCH",
                    "The role did not resolve to the current platform System WebView.",
                ));
            }
            let (surface, navigation, base_zoom_factor, effective_zoom) = {
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
                    base_zoom_factor,
                    effective_zoom_factor(base_zoom_factor, window_zoom_factor),
                )
            };
            let url = checked_web_url(&role.url)?;
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
                .set_zoom(effective_zoom)
                .map_err(RuntimeError::tauri)?;
            pending_navigations.push((role.role_id, surface, navigation));
        }

        // Start every role navigation before waiting for any one of them. A workspace can
        // contain up to nine roles; waiting inside the loop serialized the network wait and
        // made one slow page delay every role behind it.
        for (role_id, surface, navigation) in pending_navigations {
            navigation
                .wait()
                .map_err(|message| RuntimeError::new("TAURI_NAVIGATION_FAILED", message))?;
            if restore_attestation {
                eprintln!(
                    "Runtime restore attestation: navigation finished for {}.",
                    role_id
                );
            }
            self.reassert_role_keys(&role_id, &surface)?;
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

    fn apply_runtime(
        &self,
        snapshot: BrowserRuntimeSnapshot,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: &[String],
        focus_window_ids: &[String],
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
            window_id: String,
            focus: bool,
            moved: bool,
            source_window_id: String,
            surfaces: Vec<Webview>,
            tab_id: String,
        }
        struct HostUpdate {
            active_webview: Option<Webview>,
            focus: bool,
            presentation: String,
            reveal: bool,
            retain_visibility: bool,
            title: Option<String>,
            window: Window,
        }

        let ensured_target_host = if let Some(target) = target.as_ref() {
            let title = snapshot
                .windows
                .iter()
                .find(|window| window.window_id == target.window_id)
                .and_then(|window| window.active_tab_id.as_deref())
                .and_then(|tab_id| snapshot.tabs.iter().find(|tab| tab.id == tab_id))
                .map(|tab| tab.name.as_str())
                .unwrap_or(RION_STUDIO_APP_NAME);
            let (_, created) = self.ensure_display_host(target, title, false)?;
            Some((target.window_id.clone(), created))
        } else {
            None
        };

        let active_tabs = snapshot
            .windows
            .iter()
            .filter_map(|window| {
                window
                    .active_tab_id
                    .as_ref()
                    .map(|tab_id| (window.window_id.as_str(), tab_id.as_str()))
            })
            .collect::<HashMap<_, _>>();
        let suppress_focus = self
            .core
            .invoke(CoreCommand::RuntimeRestoreSessionGet)
            .ok()
            .and_then(|value| serde_json::from_value::<RuntimeRestoreSessionRecord>(value).ok())
            .is_some_and(|session| !session.restore_in_progress_window_ids.is_empty());
        let game_window_names = self
            .core
            .invoke(CoreCommand::GameWindowsList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateGameWindowRecord>>(value).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|window| (window.id, window.name))
            .collect::<HashMap<_, _>>();
        let desired_windows = snapshot
            .windows
            .iter()
            .map(|window| window.window_id.as_str())
            .collect::<HashSet<_>>();
        let live_windows = self
            .state()?
            .tabs
            .iter()
            .map(|(tab_id, tab)| (tab_id.clone(), tab.window_id.clone()))
            .collect::<HashMap<_, _>>();
        let host_plan =
            resolve_runtime_tab_host_plan(&snapshot, &live_windows, focus_window_ids, focus_tab_id);
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
                        window_id: plan.window_id.clone(),
                        focus: plan.focus,
                        moved: plan.moved,
                        source_window_id: runtime_tab.window_id.clone(),
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
                let window = self.window_for_id(&update.window_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "The target runtime display host was not found.",
                    )
                })?;
                let source_window =
                    self.window_for_id(&update.source_window_id)
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
                        if let Some((window_id, created)) = &ensured_target_host {
                            self.remove_empty_display_host(window_id, *created);
                        }
                        return Err(RuntimeError::tauri(error));
                    }
                    if let Err(error) = surface.reparent(&window) {
                        for (moved_surface, original_window) in reparented_surfaces.iter().rev() {
                            let _ = moved_surface.reparent(original_window);
                        }
                        if let Some((window_id, created)) = &ensured_target_host {
                            self.remove_empty_display_host(window_id, *created);
                        }
                        return Err(RuntimeError::tauri(error));
                    }
                    reparented_surfaces.push((surface.clone(), source_window.clone()));
                }
            }
        }

        trace("updating runtime state");
        let obsolete_window_ids = {
            let mut state = self.state()?;
            if let Some(target) = target.as_ref()
                && let Some(host) = state.display_hosts.get_mut(&target.window_id)
            {
                host.target = target.clone();
            }
            for update in &tab_updates {
                if let Some(runtime_tab) = state.tabs.get_mut(&update.tab_id) {
                    runtime_tab.window_id = update.window_id.clone();
                }
            }
            state
                .display_hosts
                .keys()
                .filter(|window_id| !desired_windows.contains(window_id.as_str()))
                .cloned()
                .collect::<Vec<_>>()
        };

        if let Some(target) = target.as_ref()
            && let Some(window) = self.window_for_id(&target.window_id)
        {
            if window.is_fullscreen().unwrap_or(false) {
                window.set_fullscreen(false).map_err(RuntimeError::tauri)?;
            }
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(RuntimeError::tauri)?;
            }
            trace("setting display host position");
            window
                .set_position(LogicalPosition::new(
                    target.bounds.x as f64,
                    target.bounds.y as f64,
                ))
                .map_err(RuntimeError::tauri)?;
            trace("setting display host size");
            window
                .set_size(LogicalSize::new(
                    target.bounds.width.max(1) as f64,
                    target.bounds.height.max(1) as f64,
                ))
                .map_err(RuntimeError::tauri)?;
        }

        for update in &tab_updates {
            if update.moved
                || target
                    .as_ref()
                    .is_some_and(|target| target.window_id == update.window_id)
            {
                self.layout_runtime_tab(&update.tab_id)?;
            }
            for surface in &update.surfaces {
                // On Windows, WRY maps this visibility boundary to WebView2 IsVisible. Chromium
                // then applies its own native background throttling to inactive tab surfaces.
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
                    let window_id = &host.target.window_id;
                    let active_tab = active_tabs.get(window_id.as_str()).copied();
                    let active_webview = active_tab.and_then(|tab_id| {
                        state
                            .tabs
                            .get(tab_id)
                            .and_then(|tab| tab.roles.values().next())
                            .map(|surface| surface.webview.clone())
                    });
                    let title = game_window_names
                        .get(window_id)
                        .cloned()
                        .or_else(|| {
                            active_tab.and_then(|tab_id| {
                                snapshot
                                    .tabs
                                    .iter()
                                    .find(|tab| tab.id == tab_id)
                                    .map(|tab| tab.name.clone())
                            })
                        })
                        .map(|title| native_runtime_window_title(&title).to_owned());
                    let has_visible_active = active_tab.is_some_and(|tab_id| {
                        snapshot
                            .tabs
                            .iter()
                            .any(|tab| tab.id == tab_id && !tab.hidden)
                    });
                    HostUpdate {
                        active_webview,
                        focus: !suppress_focus
                            && (focus_window_ids.contains(window_id)
                                || tab_updates
                                    .iter()
                                    .any(|update| &update.window_id == window_id && update.focus)),
                        presentation: host.target.presentation.clone(),
                        reveal: reveal_window_ids.contains(window_id),
                        retain_visibility: has_visible_active || active_tab.is_none(),
                        title,
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
            let visible = runtime_host_should_be_visible(
                update.reveal,
                update.retain_visibility,
                currently_visible,
            );
            if visible && !currently_visible {
                trace("showing display host");
                update.window.show().map_err(RuntimeError::tauri)?;
            } else if !visible && currently_visible {
                trace("hiding display host");
                update.window.hide().map_err(RuntimeError::tauri)?;
            }
            match update.presentation.as_str() {
                "fullscreen" if !update.window.is_fullscreen().unwrap_or(false) => {
                    update
                        .window
                        .set_fullscreen(true)
                        .map_err(RuntimeError::tauri)?;
                }
                "maximized" if !update.window.is_maximized().unwrap_or(false) => {
                    update.window.maximize().map_err(RuntimeError::tauri)?;
                }
                _ => {}
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
            obsolete_window_ids
                .into_iter()
                .filter_map(|window_id| {
                    let host = state.display_hosts.remove(&window_id)?;
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
        let preferences = crate::runtime_tabs_macos::runtime_window_preferences(&self.core);
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
                let window_id = &host.target.window_id;
                let active_id = snapshot
                    .windows
                    .iter()
                    .find(|window| &window.window_id == window_id)
                    .and_then(|window| window.active_tab_id.as_deref());
                let tabs = snapshot
                    .tabs
                    .iter()
                    .filter(|tab| &tab.window_id == window_id && !tab.hidden)
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
                (host.tabs_controller.clone(), window_id.clone(), tabs)
            })
            .collect::<Vec<_>>();
        drop(state);
        for (controller, window_id, tabs) in updates {
            let _ = controller.update(
                &window_id,
                tabs,
                preferences.always_show_toolbar_in_full_screen,
                preferences.always_hide_tab_close_button,
                &language,
            );
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
        let preferences = self
            .core
            .invoke(CoreCommand::RuntimeWindowPreferencesGet)
            .unwrap_or(Value::Null);
        let always_hide_tab_close_button = preferences["alwaysHideTabCloseButton"]
            .as_bool()
            .unwrap_or(false);
        let always_show = preferences["alwaysShowToolbarInFullScreen"]
            .as_bool()
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
            .and_then(|window| crate::display_inventory(&window).ok())
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
                                    .map(|icon| {
                                        (snapshot_tab.id.clone(), Value::String(icon.clone()))
                                    })
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
                                "alwaysHideTabCloseButton".to_owned(),
                                json!(always_hide_tab_close_button),
                            );
                            object.insert(
                                "alwaysShowToolbarInFullScreen".to_owned(),
                                json!(always_show),
                            );
                            object.insert("displayId".to_owned(), json!(host.target.display_id));
                            object.insert("windowId".to_owned(), json!(host.target.window_id));
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
        self.persist_local_storage_sync_source_before_stop(role_id)?;
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

    fn persist_local_storage_sync_source_before_stop(&self, role_id: &str) -> RuntimeResult<()> {
        let (webview, config) = {
            let state = self.state()?;
            let Some(tab_id) = state.role_tabs.get(role_id) else {
                return Ok(());
            };
            let Some(surface) = state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(role_id))
            else {
                return Ok(());
            };
            let Some(config) = surface.local_storage_sync.clone() else {
                return Ok(());
            };
            (surface.webview.clone(), config)
        };
        if config.source_role_id.is_some() || config.dependent_role_ids.is_empty() {
            return Ok(());
        }
        if require_exact_local_storage_sync_origin(&webview, &config.origin).is_err() {
            return Ok(());
        }
        let Ok(entries) = read_scoped_local_storage_entries(&webview, &config.keys) else {
            return Ok(());
        };
        // The document observer reports asynchronously. Capture the live source immediately
        // before closing it so a stop cannot leave the encrypted bootstrap snapshot stale.
        self.persist_local_storage_sync_snapshot(PersistedLocalStorageSyncSnapshot {
            schema_version: 1,
            source_role_id: role_id.to_owned(),
            origin: config.origin,
            entries,
        })
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
            let window_id = &tab.window_id;
            let host = state.display_hosts.get(window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "Runtime display host was not found.",
                )
            })?;
            let updates = state
                .tabs
                .iter()
                .filter(|(_, candidate)| candidate.window_id == *window_id)
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
                // Role parity temporarily reveals native windows on macOS. Run it before the
                // hidden trusted-input probe so those windows cannot leave the probe document
                // focused and invalidate its background-input assertion.
                let role_parity = run_role_count_attestation(&runtime)?;
                let mut report = run_trusted_input_attestation(&webview, page_receiver)?;
                report["simulatedStress"] = run_simulated_input_stress(&runtime.core)?;
                report["registration"] =
                    serde_json::to_value(runtime.registration()).map_err(|error| {
                        RuntimeError::new("SYSTEM_INPUT_ATTESTATION_INVALID", error.to_string())
                    })?;
                report["roleParity"] = role_parity;
                Ok(report)
            }))
            .unwrap_or_else(|_| {
                Err(input_attestation_error(
                    "The trusted-input attestation worker panicked.",
                ))
            });
            let (document, exit_code) = match outcome {
                Ok(report) => (
                    json!({
                        "schemaVersion": 2,
                        "ok": true,
                        "platform": if cfg!(windows) { "windows" } else { "macos" },
                        "engine": if cfg!(windows) { "webview2" } else { "wkwebview" },
                        "report": report
                    }),
                    0,
                ),
                Err(error) => (
                    json!({
                        "schemaVersion": 2,
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
    let held = wait_for_attestation_state(
        webview,
        AttestationInputCounts {
            key_down: 1,
            key_up: 0,
            held: 1,
            mouse_down: 0,
            mouse_up: 0,
        },
    )?;
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
    wait_for_attestation_state(
        webview,
        AttestationInputCounts {
            key_down: 4,
            key_up: 3,
            held: 0,
            mouse_down: 1,
            mouse_up: 0,
        },
    )?;
    dispatch_mouse_effect(webview, ClickPoint { x: 32, y: 32 }, "left", false)?;
    let behavior = wait_for_attestation_state(
        webview,
        AttestationInputCounts {
            key_down: 4,
            key_up: 3,
            held: 0,
            mouse_down: 1,
            mouse_up: 1,
        },
    )?;
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

    Ok(json!({
        "behavior": behavior,
        "nativeKeyDown": 4,
        "nativeKeyUp": 3
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn run_simulated_input_stress(core: &AppCore) -> RuntimeResult<Value> {
    const CYCLES: u64 = 1_000;
    const ROLE_ID: &str = "simulated-input-attestation";
    const OWNER_ID: &str = "simulated-input-soak";
    let result = (|| {
        let mut key_down = 0_u64;
        let mut key_up = 0_u64;
        for _ in 0..CYCLES {
            let transition = core
                .invoke(CoreCommand::EmbeddedKeyPrepare {
                    role_id: ROLE_ID.to_owned(),
                    phase: "tap".to_owned(),
                    code: "KeyA".to_owned(),
                    modifier_codes: Vec::new(),
                    owner_id: OWNER_ID.to_owned(),
                })
                .map_err(RuntimeError::core)
                .and_then(|value| {
                    serde_json::from_value::<EmbeddedKeyTransitionRecord>(value).map_err(|error| {
                        RuntimeError::new("SYSTEM_INPUT_ATTESTATION_INVALID", error.to_string())
                    })
                })?;
            for effect in &transition.effects {
                if effect.code != "KeyA" {
                    return Err(input_attestation_error(
                        "The simulated input state emitted an unexpected key code.",
                    ));
                }
                match effect.phase.as_str() {
                    "rawKeyDown" => key_down += 1,
                    "keyUp" => key_up += 1,
                    _ => {
                        return Err(input_attestation_error(
                            "The simulated input state emitted an unexpected key phase.",
                        ));
                    }
                }
            }
            if transition.has_held_keys || transition.effects.len() != 2 {
                return Err(input_attestation_error(
                    "The simulated input state did not produce a balanced tap.",
                ));
            }
            let transition_id = transition.transition_id.ok_or_else(|| {
                input_attestation_error("The simulated input transition has no identifier.")
            })?;
            core.invoke(CoreCommand::EmbeddedKeyComplete {
                transition_id,
                succeeded: true,
            })
            .map_err(RuntimeError::core)?;
        }
        let held = core
            .invoke(CoreCommand::EmbeddedKeysHeld {
                role_id: ROLE_ID.to_owned(),
            })
            .map_err(RuntimeError::core)?;
        if held != Value::Bool(false) || key_down != CYCLES || key_up != CYCLES {
            return Err(input_attestation_error(
                "The simulated input stress run left an unbalanced key state.",
            ));
        }
        Ok(json!({
            "cycles": CYCLES,
            "heldCount": 0,
            "keyDown": key_down,
            "keyUp": key_up,
            "transport": "simulated-core-input-state"
        }))
    })();
    let cleanup = core
        .invoke(CoreCommand::EmbeddedKeysClear {
            role_id: ROLE_ID.to_owned(),
        })
        .map_err(RuntimeError::core);
    match (result, cleanup) {
        (Ok(report), Ok(_)) => Ok(report),
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn destroy_attestation_tab(
    runtime: &SystemRuntimeExecutor,
    tab_id: &str,
    window_id: &str,
) -> RuntimeResult<()> {
    runtime.destroy_tab(tab_id)?;
    runtime.discard_provisional_game_window(window_id);
    Ok(())
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
        let window_id = format!("attestation-layout-{count}");
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
                window_id: window_id.clone(),
                display_id: -9_999,
                work_area: rion_core::StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 960,
                    height: 640,
                },
                bounds: rion_core::StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 960,
                    height: 640,
                },
                presentation: "normal".to_owned(),
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
        let cleanup = destroy_attestation_tab(runtime, &tab_id, &window_id);
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
            || state.display_hosts.contains_key(&window_id)
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
    eprintln!("System WebView parity: validating shared display host lifecycle.");
    let shared_display_host = verify_shared_display_host_attestation(runtime, &server)?;
    eprintln!("System WebView parity: shared display host lifecycle complete.");
    eprintln!("System WebView parity: validating compatibility surface lifecycle.");
    let compatibility = verify_compatibility_surface_attestation(runtime, &server)?;
    eprintln!("System WebView parity: compatibility surface lifecycle complete.");
    drop(server);
    Ok(json!({
        "counts": [1, 3, 6, 9],
        "createDestroyCycles": create_destroy_cycles,
        "compatibility": compatibility,
        "sharedDisplayHost": shared_display_host,
        "layouts": layouts,
        "popupDownload": popup_download,
        "recovery": recovery,
        "totalRoles": total_roles
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn verify_compatibility_surface_attestation(
    runtime: &SystemRuntimeExecutor,
    server: &AttestationServer,
) -> RuntimeResult<Value> {
    let game_id = "system-webview-compatibility-attestation";
    let first_plan = CompatibilityCheckPlanRecord {
        game_id: game_id.to_owned(),
        game_name: "System WebView compatibility attestation".to_owned(),
        launch_url: server.url("compatibility-first"),
        started_at: "2026-07-27T00:00:00.000Z".to_owned(),
    };
    runtime.create_compatibility_surface(first_plan.clone())?;
    let verification = (|| {
        runtime.require_compatibility_surface(game_id)?;
        let final_url = runtime.load_compatibility_url(game_id, &first_plan.launch_url)?;
        let webview = runtime.compatibility_webview(game_id)?;
        let first = evaluate_attestation_value(
            &webview,
            "({ ready: document.readyState === 'complete', origin: location.origin, stored: (localStorage.setItem('rion-compatibility-attestation', 'first'), localStorage.getItem('rion-compatibility-attestation')) })",
        )?;
        if first["ready"] != json!(true)
            || first["stored"] != json!("first")
            || !final_url.starts_with(&format!("http://{}", server.address))
        {
            return Err(input_attestation_error(format!(
                "The compatibility System WebView did not load and probe correctly: {first}."
            )));
        }
        Ok(final_url)
    })();
    let first_cleanup = runtime.cleanup_compatibility_surface(game_id);
    let final_url = verification?;
    first_cleanup?;
    if runtime.require_compatibility_surface(game_id).is_ok() {
        return Err(input_attestation_error(
            "The compatibility System WebView remained registered after cleanup.",
        ));
    }

    let second_plan = CompatibilityCheckPlanRecord {
        game_id: game_id.to_owned(),
        game_name: "System WebView compatibility isolation attestation".to_owned(),
        launch_url: server.url("compatibility-second"),
        started_at: "2026-07-27T00:00:01.000Z".to_owned(),
    };
    runtime.create_compatibility_surface(second_plan.clone())?;
    let isolation = (|| {
        runtime.load_compatibility_url(game_id, &second_plan.launch_url)?;
        let webview = runtime.compatibility_webview(game_id)?;
        evaluate_attestation_value(
            &webview,
            "({ ready: document.readyState === 'complete', stored: localStorage.getItem('rion-compatibility-attestation') })",
        )
    })();
    let second_cleanup = runtime.cleanup_compatibility_surface(game_id);
    let isolation = isolation?;
    second_cleanup?;
    if isolation["ready"] != json!(true) || !isolation["stored"].is_null() {
        return Err(input_attestation_error(format!(
            "The recreated compatibility System WebView reused isolated storage: {isolation}."
        )));
    }
    Ok(json!({
        "cleanupReleased": true,
        "finalUrl": final_url,
        "isolatedStorage": true,
        "loaded": true,
        "probeExecuted": true,
        "recreated": true
    }))
}

#[cfg(any(windows, target_os = "macos"))]
fn verify_shared_display_host_attestation(
    runtime: &SystemRuntimeExecutor,
    server: &AttestationServer,
) -> RuntimeResult<Value> {
    const DISPLAY_ID: i64 = -9_998;
    const WINDOW_ID: &str = "attestation-shared-window";
    let target = EmbeddedLaunchTargetRecord {
        window_id: WINDOW_ID.to_owned(),
        display_id: DISPLAY_ID,
        work_area: rion_core::StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 640,
            height: 480,
        },
        bounds: rion_core::StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 640,
            height: 480,
        },
        presentation: "normal".to_owned(),
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
        let _ = destroy_attestation_tab(runtime, first_tab_id, WINDOW_ID);
        return Err(error);
    }
    let result = (|| -> RuntimeResult<Value> {
        let snapshot = |active_tab_id: &str| -> RuntimeResult<BrowserRuntimeSnapshot> {
            serde_json::from_value(json!({
                "windows": [{
                    "windowId": WINDOW_ID,
                    "activeTabId": active_tab_id,
                    "tabIds": [first_tab_id, second_tab_id]
                }],
                "roles": [],
                "tabs": [
                    {
                        "id": first_tab_id,
                        "sourceId": "attestation-shared-role-a",
                        "name": first_tab_id,
                        "windowId": WINDOW_ID,
                        "tabType": "role",
                        "roleIds": ["attestation-shared-role-a"],
                        "hidden": false
                    },
                    {
                        "id": second_tab_id,
                        "sourceId": "attestation-shared-role-b",
                        "name": second_tab_id,
                        "windowId": WINDOW_ID,
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
            &[WINDOW_ID.to_owned()],
            &[],
            None,
        )?;
        let (window_label, native_handle, surface_labels, first_webview, first_navigation) = {
            let state = runtime.state()?;
            let host = state.display_hosts.get(WINDOW_ID).ok_or_else(|| {
                input_attestation_error("The shared display host was not created.")
            })?;
            if state
                .tabs
                .values()
                .filter(|tab| tab.window_id == WINDOW_ID)
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
        runtime.apply_runtime(
            snapshot(second_tab_id)?,
            None,
            &[WINDOW_ID.to_owned()],
            &[],
            None,
        )?;
        let state = runtime.state()?;
        let host = state.display_hosts.get(WINDOW_ID).ok_or_else(|| {
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
    let cleanup = destroy_attestation_tab(runtime, second_tab_id, WINDOW_ID);
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
    let window = runtime.window_for_role(role_id).ok_or_else(|| {
        input_attestation_error("The System WebView recovery host window was not found.")
    })?;
    // The role parity probe reveals the host so navigation and popup behavior can be
    // tested. Hide it before replacing the native surface so the recovery probe
    // continues to exercise trusted background input rather than focused input.
    window.hide().map_err(RuntimeError::tauri)?;
    std::thread::sleep(TRUSTED_INPUT_EVENT_INTERVAL);
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
    recovered.hide().map_err(RuntimeError::tauri)?;
    recovered
        .eval("window.blur()")
        .map_err(RuntimeError::tauri)?;
    let focus_deadline = Instant::now() + PLATFORM_CALLBACK_TIMEOUT;
    loop {
        if let Ok(focus) =
            evaluate_attestation_value(&recovered, "({ focused: document.hasFocus() })")
            && focus.get("focused") == Some(&Value::Bool(false))
        {
            break;
        }
        if Instant::now() >= focus_deadline {
            return Err(input_attestation_error(
                "The recovered System WebView remained focused after its host was hidden.",
            ));
        }
        std::thread::sleep(TRUSTED_INPUT_EVENT_INTERVAL);
    }
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
    let input = wait_for_attestation_state(
        &recovered,
        AttestationInputCounts {
            key_down: 1,
            key_up: 1,
            held: 0,
            mouse_down: 0,
            mouse_up: 0,
        },
    )?;
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
    let popup_point = attestation_element_center(&parent, "popup")?;
    dispatch_mouse_effect(&parent, popup_point, "left", true)?;
    std::thread::sleep(Duration::from_millis(2));
    dispatch_mouse_effect(&parent, popup_point, "left", false)?;

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
    let download_point = attestation_element_center(&parent, "download")?;
    dispatch_mouse_effect(&parent, download_point, "left", true)?;
    std::thread::sleep(Duration::from_millis(2));
    dispatch_mouse_effect(&parent, download_point, "left", false)?;
    let destination = tracker.wait()?;
    wait_for_download_attestation_content(&destination)?;
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
fn attestation_element_center(webview: &Webview, element_id: &str) -> RuntimeResult<ClickPoint> {
    let element_id = serde_json::to_string(element_id)
        .map_err(|error| input_attestation_error(error.to_string()))?;
    let source = format!(
        r#"(() => {{
            const element = document.getElementById({element_id});
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }};
        }})()"#
    );
    let value = evaluate_attestation_value(webview, &source)?;
    let x = value
        .get("x")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    let y = value
        .get("y")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    match (x, y) {
        (Some(x), Some(y)) if x >= 0.0 && y >= 0.0 => Ok(ClickPoint {
            x: x.round() as i64,
            y: y.round() as i64,
        }),
        _ => Err(input_attestation_error(format!(
            "The System WebView attestation element {element_id} has no usable bounds: {value}."
        ))),
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_download_attestation_content(destination: &Path) -> RuntimeResult<()> {
    let deadline = Instant::now() + PLATFORM_CALLBACK_TIMEOUT;
    loop {
        let downloaded = fs::read(destination);
        if downloaded
            .as_deref()
            .is_ok_and(|bytes| bytes == DOWNLOAD_ATTESTATION_BODY)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let detail = match downloaded {
                Ok(bytes) => format!("received {} bytes", bytes.len()),
                Err(error) => error.to_string(),
            };
            return Err(input_attestation_error(format!(
                "The System WebView download content was invalid at {} ({detail}).",
                destination.display()
            )));
        }
        std::thread::sleep(TRUSTED_INPUT_EVENT_INTERVAL);
    }
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
    let upload_point = attestation_element_center(webview, "upload")?;
    dispatch_mouse_effect(webview, upload_point, "left", true)?;
    std::thread::sleep(Duration::from_millis(2));
    dispatch_mouse_effect(webview, upload_point, "left", false)?;
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
        let window_id = format!("attestation-soak-window-{cycle}");
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
                window_id: window_id.clone(),
                display_id: -9_999,
                work_area: rion_core::StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 320,
                    height: 240,
                },
                bounds: rion_core::StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 640,
                    height: 480,
                },
                presentation: "normal".to_owned(),
            },
            roles: vec![role],
        })?;
        destroy_attestation_tab(runtime, &tab_id, &window_id)?;
        let state = runtime.state()?;
        if state.tabs.contains_key(&tab_id)
            || state.role_tabs.contains_key(&role_id)
            || state.display_hosts.contains_key(&window_id)
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
        local_storage_sync: None,
        role: StateRoleRecord {
            id: role_id.clone(),
            game_id: "attestation-game".to_owned(),
            name: format!("Attestation role {index}"),
            launch_url: "http://127.0.0.1/".to_owned(),
            notes: String::new(),
            cover_image_data_url: None,
            cover_image_dominant_color: None,
            local_storage_source_role_id: None,
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
        let host = state.display_hosts.get(&tab.window_id).ok_or_else(|| {
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
    let content_metrics = {
        let metrics = logical_window_content_metrics(&window)?;
        #[cfg(windows)]
        {
            // The existing native query is stable in the attestation worker. Apply the
            // Windows-owned tab-strip inset locally instead of re-entering the runtime
            // wrapper here, which can block WebView2 while the hidden host is settling.
            let mut metrics = metrics;
            metrics.top_inset += WINDOWS_TAB_STRIP_HEIGHT;
            metrics.height = (metrics.height - WINDOWS_TAB_STRIP_HEIGHT).max(1.0);
            metrics
        }
        #[cfg(not(windows))]
        {
            metrics
        }
    };
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

    // macOS 26 can suspend a WKWebView that is created inside a hidden host before it
    // dispatches its first page-load callback. The real launch sequence reveals the role
    // surfaces and their host before loading, so mirror that sequence here after asserting
    // that create_tab initially kept the native surfaces hidden.
    window.show().map_err(RuntimeError::tauri)?;
    for (_, webview, _, _) in &surfaces {
        webview.show().map_err(RuntimeError::tauri)?;
    }

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
    // Pace the bounded native parity probe so its synthetic events cannot resemble
    // a stuck key or overwhelm the focused System WebView.
    std::thread::sleep(TRUSTED_INPUT_EVENT_INTERVAL);
    Ok(())
}

#[cfg(any(windows, target_os = "macos"))]
fn attestation_snapshot(webview: &Webview) -> RuntimeResult<Value> {
    evaluate_attestation_value(webview, "__rionInputAttestation.snapshot()")
}

#[cfg(any(windows, target_os = "macos"))]
#[derive(Clone, Copy, Debug)]
struct AttestationInputCounts {
    key_down: u64,
    key_up: u64,
    held: u64,
    mouse_down: u64,
    mouse_up: u64,
}

#[cfg(any(windows, target_os = "macos"))]
impl AttestationInputCounts {
    fn matches(self, snapshot: &Value) -> bool {
        snapshot.get("keyDown").and_then(Value::as_u64) == Some(self.key_down)
            && snapshot.get("keyUp").and_then(Value::as_u64) == Some(self.key_up)
            && snapshot.get("heldCount").and_then(Value::as_u64) == Some(self.held)
            && snapshot.get("mouseDown").and_then(Value::as_u64) == Some(self.mouse_down)
            && snapshot.get("mouseUp").and_then(Value::as_u64) == Some(self.mouse_up)
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_attestation_state(
    webview: &Webview,
    expected: AttestationInputCounts,
) -> RuntimeResult<Value> {
    let deadline = Instant::now() + PLATFORM_CALLBACK_TIMEOUT;
    loop {
        let snapshot = attestation_snapshot(webview)?;
        if expected.matches(&snapshot) {
            return Ok(snapshot);
        }
        if Instant::now() >= deadline {
            return Err(input_attestation_error(format!(
                "System WebView input delivery did not converge to {expected:?}; snapshot: {snapshot}."
            )));
        }
        std::thread::sleep(TRUSTED_INPUT_EVENT_INTERVAL);
    }
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

fn effect_session_paths(
    webview2_user_data_dir: &str,
    webkit_data_store_identifier: &str,
) -> RuntimeResult<SessionPaths> {
    let webview2 = PathBuf::from(webview2_user_data_dir);
    if !webview2.is_absolute()
        || webview2
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(RuntimeError::new(
            "SESSION_IMPORT_STORE_INVALID",
            "The role WebView2 data directory is invalid.",
        ));
    }
    let webkit_identifier = uuid::Uuid::parse_str(webkit_data_store_identifier)
        .map_err(|_| {
            RuntimeError::new(
                "SESSION_IMPORT_STORE_INVALID",
                "The role WKWebsiteDataStore identifier is invalid.",
            )
        })?
        .into_bytes();
    Ok(SessionPaths {
        webkit_identifier,
        webview2,
    })
}

fn current_platform() -> rion_platform::Platform {
    if cfg!(target_os = "macos") {
        rion_platform::Platform::Macos
    } else {
        rion_platform::Platform::Windows
    }
}

fn write_private_file(directory: &Path, name: &str, value: &[u8]) -> RuntimeResult<()> {
    fs::create_dir_all(directory).map_err(RuntimeError::io)?;
    #[cfg(unix)]
    {
        use std::{
            io::Write,
            os::unix::fs::{OpenOptionsExt, PermissionsExt},
        };
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(RuntimeError::io)?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(directory.join(name))
            .map_err(RuntimeError::io)?;
        file.write_all(value).map_err(RuntimeError::io)?;
        file.sync_all().map_err(RuntimeError::io)?;
    }
    #[cfg(windows)]
    fs::write(directory.join(name), value).map_err(RuntimeError::io)?;
    rion_platform::restrict_directory_to_current_user(directory)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string()))
}

fn validate_transaction_id(value: &str) -> RuntimeResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err(RuntimeError::new(
            "SESSION_IMPORT_TRANSACTION_INVALID",
            "Session-transfer transaction ID is invalid.",
        ))
    } else {
        Ok(())
    }
}

fn close_hidden_surface(window: Window, webview: Webview) {
    let _ = webview.close();
    let _ = window.close();
}

fn normalized_cookie_domain(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

fn cookies_for_launch(webview: &Webview, launch: &Url) -> RuntimeResult<Vec<Cookie<'static>>> {
    Ok(webview
        .cookies()
        .map_err(RuntimeError::tauri)?
        .into_iter()
        .filter(|cookie| native_cookie_matches_launch(cookie, launch))
        .collect())
}

fn native_cookie_matches_launch(cookie: &Cookie<'_>, launch: &Url) -> bool {
    let Some(host) = launch.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    let domain = normalized_cookie_domain(cookie.domain());
    let domain_matches =
        host == domain || (!domain.is_empty() && host.ends_with(&format!(".{domain}")));
    let cookie_path = cookie.path().unwrap_or("/");
    domain_matches
        && native_cookie_path_matches(launch.path(), cookie_path)
        && (!cookie.secure().unwrap_or(false) || launch.scheme() == "https")
}

fn native_cookie_path_matches(request_path: &str, cookie_path: &str) -> bool {
    request_path == cookie_path
        || (request_path.starts_with(cookie_path)
            && (cookie_path.ends_with('/')
                || request_path.as_bytes().get(cookie_path.len()) == Some(&b'/')))
}

fn native_cookie_key(cookie: &Cookie<'_>) -> (String, String, String) {
    (
        normalized_cookie_domain(cookie.domain()),
        cookie.path().unwrap_or("/").to_owned(),
        cookie.name().to_owned(),
    )
}

fn native_cookie_record(cookie: &Cookie<'_>) -> SessionCookieRecord {
    SessionCookieRecord {
        name: cookie.name().to_owned(),
        value: cookie.value().to_owned(),
        domain: cookie.domain().map(str::to_owned),
        path: cookie.path().unwrap_or("/").to_owned(),
        secure: cookie.secure().unwrap_or(false),
        http_only: cookie.http_only().unwrap_or(false),
        same_site: match cookie.same_site() {
            Some(SameSite::Strict) => "strict",
            Some(SameSite::Lax) => "lax",
            Some(SameSite::None) => "none",
            None => "unspecified",
        }
        .to_owned(),
        expires_unix_ms: cookie
            .expires_datetime()
            .map(|expires| expires.unix_timestamp() * 1_000),
    }
}

fn transfer_cookie_key(cookie: &SessionCookieRecord, launch: &Url) -> (String, String, String) {
    (
        normalized_cookie_domain(cookie.domain.as_deref().or_else(|| launch.host_str())),
        cookie.path.clone(),
        cookie.name.clone(),
    )
}

fn transfer_cookie(record: &SessionCookieRecord, launch: &Url) -> RuntimeResult<Cookie<'static>> {
    let domain = record
        .domain
        .as_deref()
        .or_else(|| launch.host_str())
        .ok_or_else(|| {
            RuntimeError::new(
                "SESSION_IMPORT_COOKIE_INVALID",
                "Imported cookie has no valid domain.",
            )
        })?;
    let mut builder = Cookie::build((record.name.clone(), record.value.clone()))
        .domain(domain.to_owned())
        .path(record.path.clone());
    // Wry's WKWebView adapter serializes `Some(false)` as the string `FALSE`.
    // NSHTTPCookie treats presence of Secure/HttpOnly as enabled, so false flags
    // must remain absent while true flags are explicit.
    if record.secure {
        builder = builder.secure(true);
    }
    if record.http_only {
        builder = builder.http_only(true);
    }
    builder = match record.same_site.as_str() {
        "strict" => builder.same_site(SameSite::Strict),
        "lax" => builder.same_site(SameSite::Lax),
        "none" if record.secure => builder.same_site(SameSite::None),
        _ => builder,
    };
    if let Some(timestamp) = record.expires_unix_ms
        && let Ok(expires) = OffsetDateTime::from_unix_timestamp(timestamp / 1_000)
    {
        builder = builder.expires(expires);
    }
    Ok(builder.build())
}

fn verify_cookie_readback(
    expected: &[Cookie<'static>],
    actual: &[Cookie<'static>],
) -> RuntimeResult<()> {
    for cookie in expected {
        let key = native_cookie_key(cookie);
        let matches = actual.iter().any(|candidate| {
            native_cookie_key(candidate) == key
                && candidate.value() == cookie.value()
                && candidate.secure().unwrap_or(false) == cookie.secure().unwrap_or(false)
                && candidate.http_only().unwrap_or(false) == cookie.http_only().unwrap_or(false)
                && native_cookie_same_site_matches(cookie.same_site(), candidate.same_site())
        });
        if !matches {
            return Err(RuntimeError::new(
                "SESSION_IMPORT_COOKIE_VERIFY_FAILED",
                format!(
                    "System WebView did not retain imported cookie {}.",
                    cookie.name()
                ),
            ));
        }
    }
    Ok(())
}

fn native_cookie_same_site_matches(expected: Option<SameSite>, actual: Option<SameSite>) -> bool {
    expected == actual
        || matches!(
            (expected, actual),
            (None, Some(SameSite::None)) | (Some(SameSite::None), None)
        )
}

fn restore_url_cookies(
    webview: &Webview,
    launch: &Url,
    backup: &[Cookie<'static>],
) -> RuntimeResult<()> {
    let current = cookies_for_launch(webview, launch)?;
    for cookie in current {
        webview.delete_cookie(cookie).map_err(RuntimeError::tauri)?;
    }
    for cookie in backup {
        webview
            .set_cookie(cookie.clone())
            .map_err(RuntimeError::tauri)?;
    }
    let readback = cookies_for_launch(webview, launch)?;
    verify_cookie_readback(backup, &readback)
}

fn local_storage_document_start_script(
    origin: &str,
    replace_existing: bool,
    entries: &[rion_core::LocalStorageEntryRecord],
) -> RuntimeResult<String> {
    let origin = serde_json::to_string(origin)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_SCRIPT_INVALID", error.to_string()))?;
    let entries = serde_json::to_string(entries)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_SCRIPT_INVALID", error.to_string()))?;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || location.origin !== {origin}) return;
  const entries = {entries};
  const backup = Object.entries(localStorage);
  if ({replace_existing}) localStorage.clear();
  for (const item of entries) localStorage.setItem(item.key, item.value);
  Object.defineProperty(globalThis, "__rionSessionImportState", {{
    configurable: false,
    value: {{
      applied: true,
      backup,
      origin: location.origin,
      size: localStorage.length,
      values: entries.map((item) => [item.key, localStorage.getItem(item.key)])
    }}
  }});
}})();"#,
    ))
}

fn validate_local_storage_sync_contract(origin: &str, keys: &[String]) -> RuntimeResult<()> {
    let parsed = checked_web_url(origin)?;
    if parsed.origin().ascii_serialization() != origin
        || keys.is_empty()
        || keys.len() > 32
        || keys.iter().collect::<HashSet<_>>().len() != keys.len()
        || keys
            .iter()
            .any(|key| key.is_empty() || key.len() > 256 || key.trim() != key)
    {
        return Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_CONTRACT_INVALID",
            "The localStorage synchronization contract is invalid.",
        ));
    }
    Ok(())
}

fn local_storage_sync_observer_script(config: &LocalStorageRuntimeConfig) -> RuntimeResult<String> {
    validate_local_storage_sync_contract(&config.origin, &config.keys)?;
    let token = serde_json::to_string(&config.token).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization observer could not be encoded.",
        )
    })?;
    let origin = serde_json::to_string(&config.origin).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization observer could not be encoded.",
        )
    })?;
    let keys = serde_json::to_string(&config.keys).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization observer could not be encoded.",
        )
    })?;
    let is_source = config.source_role_id.is_none();
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || globalThis.__rionLocalStorageSyncObserver) return;
  const state = {{ token: {token}, origin: {origin}, keys: {keys}, lastError: null, pending: null, previous: null, timer: 0 }};
  const capture = () => state.keys.map((key) => [key, localStorage.getItem(key)]);
  const publish = () => {{
    state.timer = 0;
    if (location.origin !== state.origin) return;
    const entries = capture();
    const serialized = JSON.stringify(entries);
    if (serialized === state.previous || serialized === state.pending) return;
    const internals = globalThis.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return;
    state.pending = serialized;
    void internals.invoke("rion_local_storage_sync_changed", {{ token: state.token, entries }})
      .then(() => {{ if (state.pending === serialized) {{ state.lastError = null; state.previous = serialized; state.pending = null; }} }})
      .catch((error) => {{ state.lastError = String(error); if (state.pending === serialized) state.pending = null; schedule(); }});
  }};
  const schedule = () => {{
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(publish, 100);
  }};
  for (const name of ["storage", "pageshow", "visibilitychange"]) addEventListener(name, schedule, true);
  setInterval(schedule, 250);
  if ({is_source}) {{
    const storagePrototype = globalThis.Storage?.prototype;
    if (storagePrototype) {{
      const setItem = storagePrototype.setItem;
      const removeItem = storagePrototype.removeItem;
      const clear = storagePrototype.clear;
      storagePrototype.setItem = function (key, value) {{
        const result = setItem.call(this, key, value);
        if (this === localStorage) publish();
        return result;
      }};
      storagePrototype.removeItem = function (key) {{
        const result = removeItem.call(this, key);
        if (this === localStorage) publish();
        return result;
      }};
      storagePrototype.clear = function () {{
        const result = clear.call(this);
        if (this === localStorage) publish();
        return result;
      }};
    }}
  }}
  globalThis.__rionLocalStorageSyncObserver = Object.freeze({{
    configure(next) {{
      if (!next || next.token !== state.token) return false;
      state.origin = next.origin;
      state.keys = [...next.keys];
      state.pending = null;
      state.previous = null;
      schedule();
      return true;
    }},
    snapshot() {{ return {{ hasPrevious: state.previous !== null, lastError: state.lastError, pending: state.pending !== null }}; }}
  }});
  schedule();
}})();"#,
    ))
}

fn local_storage_sync_apply_script(
    snapshot: &PersistedLocalStorageSyncSnapshot,
) -> RuntimeResult<String> {
    let origin = serde_json::to_string(&snapshot.origin).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization bootstrap could not be encoded.",
        )
    })?;
    let entries = serde_json::to_string(&snapshot.entries).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization bootstrap could not be encoded.",
        )
    })?;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || location.origin !== {origin}) return;
  for (const [key, value] of {entries}) {{
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }}
}})();"#,
    ))
}

fn read_scoped_local_storage_entries(
    webview: &Webview,
    keys: &[String],
) -> RuntimeResult<Vec<(String, Option<String>)>> {
    let keys_json = serde_json::to_string(keys).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
            "The localStorage synchronization key set could not be encoded.",
        )
    })?;
    let value = evaluate_json_value(
        webview,
        &format!(
            "(() => {{ const keys = {keys_json}; return {{ values: keys.map((key) => [key, localStorage.getItem(key)]) }}; }})()"
        ),
    )?;
    let values = value
        .get("values")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                "The System WebView returned an invalid localStorage synchronization snapshot.",
            )
        })?;
    if values.len() != keys.len() {
        return Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
            "The System WebView returned an incomplete localStorage synchronization snapshot.",
        ));
    }
    values
        .iter()
        .zip(keys)
        .map(|(entry, expected)| {
            let pair = entry.as_array().filter(|pair| pair.len() == 2).ok_or_else(|| {
                RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                    "The System WebView returned a malformed localStorage synchronization entry.",
                )
            })?;
            if pair[0].as_str() != Some(expected) {
                return Err(RuntimeError::new(
                    "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                    "The System WebView returned an unexpected localStorage synchronization key.",
                ));
            }
            let value = if pair[1].is_null() {
                None
            } else {
                Some(pair[1].as_str().ok_or_else(|| {
                    RuntimeError::new(
                        "LOCAL_STORAGE_SYNC_SNAPSHOT_INVALID",
                        "The System WebView returned a non-string localStorage synchronization value.",
                    )
                })?.to_owned())
            };
            Ok((expected.clone(), value))
        })
        .collect()
}

fn require_exact_local_storage_sync_origin(webview: &Webview, expected: &str) -> RuntimeResult<()> {
    // WKWebView can briefly expose a nil native URL while a page transition or
    // renderer teardown is in flight. Wry 0.55 unwraps that value internally,
    // so use the document's origin for this capability check instead of calling
    // WebView::url() across that native transition boundary.
    let document = evaluate_json_value(
        webview,
        "JSON.stringify({ origin: globalThis.location?.origin ?? null })",
    )?;
    let actual = document
        .get("origin")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_ORIGIN_MISMATCH",
                "The localStorage synchronization WebView has no document origin.",
            )
        })?;
    if actual == expected {
        Ok(())
    } else {
        Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_ORIGIN_MISMATCH",
            "The localStorage synchronization WebView origin does not match its binding.",
        ))
    }
}

fn local_storage_restore_script(
    origin: &str,
    entries: &[(String, String)],
) -> RuntimeResult<String> {
    let origin = serde_json::to_string(origin)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_SCRIPT_INVALID", error.to_string()))?;
    let entries = serde_json::to_string(entries)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_SCRIPT_INVALID", error.to_string()))?;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || location.origin !== {origin}) return;
  const entries = {entries};
  localStorage.clear();
  for (const [key, value] of entries) localStorage.setItem(key, value);
  Object.defineProperty(globalThis, "__rionSessionRestoreState", {{
    configurable: false,
    value: {{
      applied: true,
      origin: location.origin,
      size: localStorage.length,
      values: Object.entries(localStorage)
    }}
  }});
}})();"#,
    ))
}

fn evaluate_json_value(webview: &Webview, source: &str) -> RuntimeResult<Value> {
    let raw = evaluate_system_webview(webview, source)?;
    let value = serde_json::from_str::<Value>(&raw).map_err(|error| {
        RuntimeError::new(
            "SESSION_IMPORT_READBACK_INVALID",
            format!("System WebView returned invalid JSON: {error}"),
        )
    })?;
    if let Some(nested) = value.as_str() {
        serde_json::from_str(nested).map_err(|error| {
            RuntimeError::new(
                "SESSION_IMPORT_READBACK_INVALID",
                format!("System WebView returned invalid nested JSON: {error}"),
            )
        })
    } else {
        Ok(value)
    }
}

fn require_exact_webview_origin(webview: &Webview, expected: &str) -> RuntimeResult<()> {
    let actual = webview
        .url()
        .map_err(RuntimeError::tauri)?
        .origin()
        .ascii_serialization();
    if actual == expected {
        Ok(())
    } else {
        Err(RuntimeError::new(
            "SESSION_IMPORT_ORIGIN_MISMATCH",
            format!("Launch page resolved to {actual}, expected {expected}."),
        ))
    }
}

fn valid_auth_probe_path(path: &str) -> bool {
    path.starts_with('/') && !path.contains(['?', '#'])
}

fn auth_probe_path_matches(actual: &str, expected: &str) -> bool {
    actual == expected
        || (actual.starts_with(expected)
            && expected != "/"
            && actual.as_bytes().get(expected.len()) == Some(&b'/'))
}

fn storage_entries_from_value(value: &Value, field: &str) -> RuntimeResult<Vec<(String, String)>> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            RuntimeError::new(
                "SESSION_IMPORT_READBACK_INVALID",
                format!("System WebView did not return LocalStorage {field}."),
            )
        })?
        .iter()
        .map(|entry| {
            let pair = entry
                .as_array()
                .filter(|pair| pair.len() == 2)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SESSION_IMPORT_READBACK_INVALID",
                        "System WebView returned a malformed LocalStorage entry.",
                    )
                })?;
            let key = pair[0].as_str().ok_or_else(|| {
                RuntimeError::new(
                    "SESSION_IMPORT_READBACK_INVALID",
                    "System WebView returned a non-string LocalStorage key.",
                )
            })?;
            let value = pair[1].as_str().ok_or_else(|| {
                RuntimeError::new(
                    "SESSION_IMPORT_READBACK_INVALID",
                    "System WebView returned a non-string LocalStorage value.",
                )
            })?;
            Ok((key.to_owned(), value.to_owned()))
        })
        .collect()
}

fn read_local_storage_entries(webview: &Webview) -> RuntimeResult<Vec<(String, String)>> {
    let value = evaluate_json_value(webview, "({ values: Object.entries(localStorage) })")?;
    storage_entries_from_value(&value, "values")
}

fn verify_local_storage_import(
    webview: &Webview,
    expected: &[rion_core::LocalStorageEntryRecord],
    replace_existing: bool,
) -> RuntimeResult<()> {
    let state = evaluate_json_value(webview, "globalThis.__rionSessionImportState ?? null")?;
    if state.get("applied").and_then(Value::as_bool) != Some(true) {
        return Err(RuntimeError::new(
            "SESSION_IMPORT_STORAGE_VERIFY_FAILED",
            "System WebView did not run the document-start LocalStorage import.",
        ));
    }
    let values = storage_entries_from_value(&state, "values")?;
    let expected_values = expected
        .iter()
        .map(|entry| (entry.key.clone(), entry.value.clone()))
        .collect::<Vec<_>>();
    if values != expected_values
        || (replace_existing
            && state.get("size").and_then(Value::as_u64) != Some(expected.len() as u64))
    {
        return Err(RuntimeError::new(
            "SESSION_IMPORT_STORAGE_VERIFY_FAILED",
            "System WebView LocalStorage readback did not match the imported data.",
        ));
    }
    Ok(())
}

fn verify_local_storage_snapshot(
    webview: &Webview,
    expected: &[(String, String)],
) -> RuntimeResult<()> {
    let state = evaluate_json_value(webview, "globalThis.__rionSessionRestoreState ?? null")?;
    let mut values = storage_entries_from_value(&state, "values")?;
    let mut expected = expected.to_vec();
    values.sort();
    expected.sort();
    if values == expected
        && state.get("size").and_then(Value::as_u64) == Some(expected.len() as u64)
    {
        Ok(())
    } else {
        Err(RuntimeError::new(
            "SESSION_IMPORT_ROLLBACK_VERIFY_FAILED",
            "System WebView LocalStorage rollback did not match its backup.",
        ))
    }
}

fn macro_overlay_document_start_script() -> Result<String, String> {
    let guard_token = serde_json::to_string(MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN)
        .map_err(|error| error.to_string())?;
    let css_token =
        serde_json::to_string(MACRO_OVERLAY_CSS_TOKEN).map_err(|error| error.to_string())?;
    let with_guard = replace_single_script_token(
        MACRO_OVERLAY_RUNTIME_SOURCE,
        &guard_token,
        MACRO_OVERLAY_SHORTCUT_GUARD_SOURCE.trim(),
    )?;
    let css = serde_json::to_string(MACRO_OVERLAY_CSS).map_err(|error| error.to_string())?;
    let runtime = replace_single_script_token(&with_guard, &css_token, &css)?;
    Ok(format!("{TAURI_MACRO_OVERLAY_BRIDGE_SOURCE}\n{runtime}"))
}

fn runtime_indicator_document_start_script() -> Result<String, String> {
    let css_token =
        serde_json::to_string(RUNTIME_INDICATOR_CSS_TOKEN).map_err(|error| error.to_string())?;
    let css = serde_json::to_string(RUNTIME_INDICATOR_CSS).map_err(|error| error.to_string())?;
    replace_single_script_token(RUNTIME_INDICATOR_RUNTIME_SOURCE, &css_token, &css)
}

fn should_refresh_macro_overlay(role_ids: &[String], role_id: &str) -> bool {
    role_ids.is_empty() || role_ids.iter().any(|candidate| candidate == role_id)
}

fn refresh_macro_overlay_handles<T, E>(
    handles: impl IntoIterator<Item = T>,
    mut refresh: impl FnMut(T) -> Result<(), E>,
) {
    for handle in handles {
        let _ = refresh(handle);
    }
}

fn should_release_macros_for_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn replace_single_script_token(
    source: &str,
    token: &str,
    replacement: &str,
) -> Result<String, String> {
    let mut matches = source.match_indices(token);
    let Some((index, _)) = matches.next() else {
        return Err(format!("Document-start script token is missing: {token}"));
    };
    if matches.next().is_some() {
        return Err(format!(
            "Document-start script token occurs more than once: {token}"
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

fn query_unlocked_snapshot<State, Snapshot, Output>(
    mutex: &Mutex<State>,
    snapshot: impl FnOnce(&State) -> Option<Snapshot>,
    query: impl FnOnce(Snapshot) -> Output,
) -> Option<Output> {
    let snapshot = {
        let state = mutex.lock().ok()?;
        snapshot(&state)?
    };
    Some(query(snapshot))
}

fn runtime_host_should_be_visible(
    reveal: bool,
    retain_visibility: bool,
    currently_visible: bool,
) -> bool {
    reveal || (currently_visible && retain_visibility)
}

fn logical_window_position(physical_x: i32, physical_y: i32, scale: f64) -> (i32, i32) {
    let scale = scale.max(f64::EPSILON);
    (
        (physical_x as f64 / scale).round() as i32,
        (physical_y as f64 / scale).round() as i32,
    )
}

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

    let role_label = webview.label().to_owned();
    let mut previous_role_label = MACOS_KEY_DISPATCH_STATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The macOS key dispatch lock was poisoned.",
            )
        })?;
    if macos_key_dispatch_needs_settle(previous_role_label.as_deref(), &role_label) {
        // WKWebView forwards AppKit key events to the web-content process
        // asynchronously. Let the previous role consume its event before the
        // next role becomes first responder. Same-role key sequences stay fast.
        std::thread::sleep(MACOS_KEY_DISPATCH_SETTLE_INTERVAL);
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
        Ok(true) => {
            *previous_role_label = Some(role_label);
            Ok(())
        }
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

#[cfg(target_os = "macos")]
fn macos_key_dispatch_needs_settle(previous_role_label: Option<&str>, role_label: &str) -> bool {
    previous_role_label.is_some_and(|previous| previous != role_label)
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

fn dispatch_role_zoom_shortcut(app: &AppHandle, webview_label: &str, action: &str) {
    let result = app
        .try_state::<crate::CoreState>()
        .ok_or_else(|| "The Rion Studio runtime is unavailable.".to_owned())
        .and_then(|state| {
            Arc::clone(&state.runtime)
                .zoom_role_for_webview(webview_label, action)
                .map(|_| ())
        });
    if let Err(message) = result {
        let _ = app.emit(
            "rion://shell-error",
            json!({
                "code": "TAURI_RUNTIME_ROLE_ZOOM_FAILED",
                "message": message
            }),
        );
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_role_zoom_action(
    virtual_key: u32,
    control: bool,
    alt: bool,
    meta: bool,
    shift: bool,
) -> Option<&'static str> {
    if !control || alt || meta {
        return None;
    }
    match virtual_key {
        0x30 | 0x60 if !shift => Some("reset"),
        0xBD | 0x6D if !shift => Some("out"),
        0xBB => Some("in"),
        0x6B if !shift => Some("in"),
        _ => None,
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn macos_role_zoom_action(
    key_code: u16,
    command: bool,
    control: bool,
    option: bool,
    shift: bool,
) -> Option<&'static str> {
    if !command || control || option {
        return None;
    }
    match key_code {
        29 | 82 if !shift => Some("reset"),
        27 | 78 if !shift => Some("out"),
        24 => Some("in"),
        69 if !shift => Some("in"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
struct MacRoleZoomShortcutContext {
    app: AppHandle,
    webview_label: String,
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_role_zoom_shortcut(
    context: *mut std::ffi::c_void,
    action: *const std::os::raw::c_char,
) {
    if context.is_null() || action.is_null() {
        return;
    }
    let context = unsafe { &*(context.cast::<MacRoleZoomShortcutContext>()) };
    let Ok(action) = unsafe { std::ffi::CStr::from_ptr(action) }.to_str() else {
        return;
    };
    dispatch_role_zoom_shortcut(&context.app, &context.webview_label, action);
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn drop_macos_role_zoom_shortcut_context(context: *mut std::ffi::c_void) {
    if !context.is_null() {
        drop(unsafe { Box::from_raw(context.cast::<MacRoleZoomShortcutContext>()) });
    }
}

#[cfg(target_os = "macos")]
fn install_role_zoom_shortcut_handler(webview: &Webview, app: AppHandle) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_install_role_zoom_shortcut(
            webview: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
            handler: unsafe extern "C" fn(
                context: *mut std::ffi::c_void,
                action: *const std::os::raw::c_char,
            ),
            destructor: unsafe extern "C" fn(context: *mut std::ffi::c_void),
        ) -> bool;
    }

    let context = Box::new(MacRoleZoomShortcutContext {
        app,
        webview_label: webview.label().to_owned(),
    });
    let context_address = Box::into_raw(context) as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let scheduling = webview.with_webview(move |platform_webview| {
        let installed = unsafe {
            rion_wk_install_role_zoom_shortcut(
                platform_webview.inner(),
                context_address as *mut std::ffi::c_void,
                macos_role_zoom_shortcut,
                drop_macos_role_zoom_shortcut_context,
            )
        };
        let _ = sender.send(installed);
    });
    if let Err(error) = scheduling {
        unsafe { drop_macos_role_zoom_shortcut_context(context_address as *mut std::ffi::c_void) };
        return Err(RuntimeError::tauri(error));
    }
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => {
            unsafe {
                drop_macos_role_zoom_shortcut_context(context_address as *mut std::ffi::c_void)
            };
            Err(RuntimeError::new(
                "SYSTEM_ROLE_ZOOM_SHORTCUT_FAILED",
                "WKWebView could not install the role zoom shortcut responder.",
            ))
        }
        Err(_) => Err(RuntimeError::new(
            "SYSTEM_ROLE_ZOOM_SHORTCUT_TIMEOUT",
            "WKWebView role zoom shortcut installation timed out.",
        )),
    }
}

#[cfg(windows)]
fn install_role_zoom_shortcut_handler(webview: &Webview, app: AppHandle) -> RuntimeResult<()> {
    use webview2_com::{
        AcceleratorKeyPressedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
            COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        },
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };

    let webview_label = webview.label().to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let shortcut_app = app.clone();
            let shortcut_label = webview_label.clone();
            let handler =
                AcceleratorKeyPressedEventHandler::create(Box::new(move |_controller, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                    args.KeyEventKind(&mut kind)?;
                    if !matches!(
                        kind,
                        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                            | COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                    ) {
                        return Ok(());
                    }
                    let mut virtual_key = 0;
                    args.VirtualKey(&mut virtual_key)?;
                    let pressed = |key: u16| GetKeyState(i32::from(key)) < 0;
                    let action = windows_role_zoom_action(
                        virtual_key,
                        pressed(VK_CONTROL.0),
                        pressed(VK_MENU.0),
                        pressed(VK_LWIN.0) || pressed(VK_RWIN.0),
                        pressed(VK_SHIFT.0),
                    );
                    let Some(action) = action else {
                        return Ok(());
                    };
                    args.SetHandled(true)?;
                    dispatch_role_zoom_shortcut(&shortcut_app, &shortcut_label, action);
                    Ok(())
                }));
            let mut token = 0;
            let result = platform_webview
                .controller()
                .add_AcceleratorKeyPressed(&handler, &mut token)
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_ROLE_ZOOM_SHORTCUT_TIMEOUT",
                "WebView2 role zoom shortcut installation timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_ROLE_ZOOM_SHORTCUT_FAILED", message))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install_role_zoom_shortcut_handler(_webview: &Webview, _app: AppHandle) -> RuntimeResult<()> {
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
                .and_then(|core| core.SetIsMuted(muted))
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
            "windows": [{
                "windowId": "window-11",
                "activeTabId": active_tab_id,
                "tabIds": ["tab-a", "tab-b"]
            }],
            "roles": [],
            "tabs": [
                {
                    "id": "tab-a",
                    "sourceId": "role-a",
                    "name": "Role A",
                    "windowId": "window-11",
                    "tabType": "role",
                    "roleIds": ["role-a"],
                    "hidden": false
                },
                {
                    "id": "tab-b",
                    "sourceId": "role-b",
                    "name": "Role B",
                    "windowId": "window-11",
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
    fn native_runtime_window_title_is_platform_explicit() {
        let original = "遊戲視窗 1";
        for (platform, expected) in [("macos", "Rion Studio"), ("windows", original)] {
            assert_eq!(
                native_runtime_window_title_for_platform(platform, original),
                expected
            );
        }
    }

    #[test]
    fn overlay_refresh_selection_supports_all_and_specific_roles() {
        let selected = vec!["role-b".to_owned()];
        assert!(should_refresh_macro_overlay(&[], "role-a"));
        assert!(!should_refresh_macro_overlay(&selected, "role-a"));
        assert!(should_refresh_macro_overlay(&selected, "role-b"));
    }

    #[test]
    fn auth_probe_paths_are_exact_or_descendants_without_prefix_confusion() {
        assert!(valid_auth_probe_path("/profile"));
        assert!(!valid_auth_probe_path("profile"));
        assert!(!valid_auth_probe_path("/profile?token=private"));
        assert!(auth_probe_path_matches("/profile", "/profile"));
        assert!(auth_probe_path_matches("/profile/security", "/profile"));
        assert!(!auth_probe_path_matches("/profiles", "/profile"));
        assert!(auth_probe_path_matches("/", "/"));
    }

    #[test]
    fn local_storage_sync_scripts_are_top_frame_origin_scoped_and_mirror_deletions() {
        let config = LocalStorageRuntimeConfig {
            dependent_role_ids: vec!["follower".to_owned()],
            keys: vec!["game_client_settings".to_owned()],
            origin: "https://example.test".to_owned(),
            source_role_id: None,
            token: "capability".to_owned(),
        };
        let observer = local_storage_sync_observer_script(&config).unwrap();
        assert!(observer.contains("globalThis.top !== globalThis"));
        assert!(observer.contains("location.origin !== state.origin"));
        assert!(observer.contains("rion_local_storage_sync_changed"));
        assert!(observer.contains("setInterval(schedule, 250)"));
        assert!(observer.contains("setTimeout(publish, 100)"));
        assert!(observer.contains("storagePrototype.setItem"));
        assert!(observer.contains("storagePrototype.removeItem"));
        assert!(observer.contains("storagePrototype.clear"));

        let script = local_storage_sync_apply_script(&PersistedLocalStorageSyncSnapshot {
            schema_version: 1,
            source_role_id: "source".to_owned(),
            origin: "https://example.test".to_owned(),
            entries: vec![
                ("game_client_settings".to_owned(), Some("{}".to_owned())),
                ("removed".to_owned(), None),
            ],
        })
        .unwrap();
        assert!(script.contains("globalThis.top !== globalThis"));
        assert!(script.contains("localStorage.removeItem(key)"));
        assert!(script.contains("localStorage.setItem(key, value)"));
        assert!(!script.contains("localStorage.clear()"));
    }

    #[test]
    fn local_storage_sync_contract_rejects_unbounded_or_non_origin_inputs() {
        assert!(
            validate_local_storage_sync_contract(
                "https://example.test",
                &["game_client_settings".to_owned()]
            )
            .is_ok()
        );
        assert!(
            validate_local_storage_sync_contract(
                "https://example.test/path",
                &["game_client_settings".to_owned()]
            )
            .is_err()
        );
        assert!(
            validate_local_storage_sync_contract(
                "https://example.test",
                &vec!["key".to_owned(); 33]
            )
            .is_err()
        );
    }

    #[test]
    fn overlay_refresh_continues_after_an_invalid_handle() {
        let mut attempted = Vec::new();
        refresh_macro_overlay_handles(["role-a", "destroyed", "role-b"], |label| {
            attempted.push(label);
            if label == "destroyed" {
                Err("WebView was destroyed")
            } else {
                Ok(())
            }
        });
        assert_eq!(attempted, ["role-a", "destroyed", "role-b"]);
    }

    #[test]
    fn macro_release_is_limited_to_top_level_game_page_navigation_schemes() {
        for url in ["https://game.example/", "http://game.example/"] {
            assert!(should_release_macros_for_navigation(
                &Url::parse(url).unwrap()
            ));
        }
        for url in [
            "about:blank",
            "rion-runtime-shortcut://tabs/next",
            "data:text/plain,internal",
        ] {
            assert!(!should_release_macros_for_navigation(
                &Url::parse(url).unwrap()
            ));
        }
    }

    #[test]
    fn macos_and_windows_tab_activation_share_one_display_host_plan() {
        for platform in ["macos", "windows"] {
            let live = HashMap::from([
                ("tab-a".to_owned(), "window-11".to_owned()),
                ("tab-b".to_owned(), "window-11".to_owned()),
            ]);
            let plan = resolve_runtime_tab_host_plan(
                &runtime_tab_host_snapshot("tab-b"),
                &live,
                &["window-11".to_owned()],
                Some("tab-b"),
            );
            assert_eq!(
                plan.iter()
                    .map(|entry| entry.window_id.clone())
                    .collect::<HashSet<_>>(),
                HashSet::from(["window-11".to_owned()]),
                "{platform} must retain one window host"
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
        snapshot.tabs[1].window_id = "window-b".to_owned();
        snapshot.windows = vec![
            rion_core::BrowserRuntimeWindowRecord {
                window_id: "window-11".to_owned(),
                active_tab_id: Some("tab-a".to_owned()),
                tab_ids: vec!["tab-a".to_owned()],
            },
            rion_core::BrowserRuntimeWindowRecord {
                window_id: "window-b".to_owned(),
                active_tab_id: Some("tab-b".to_owned()),
                tab_ids: vec!["tab-b".to_owned()],
            },
        ];
        let live = HashMap::from([
            ("tab-a".to_owned(), "window-11".to_owned()),
            ("tab-b".to_owned(), "window-11".to_owned()),
        ]);
        let plan = resolve_runtime_tab_host_plan(
            &snapshot,
            &live,
            &["window-b".to_owned()],
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

    #[test]
    fn session_transfer_scripts_are_document_start_origin_scoped_and_json_escaped() {
        let entries = vec![rion_core::LocalStorageEntryRecord {
            key: "token\"</script>".to_owned(),
            value: "value\nline".to_owned(),
        }];
        let script =
            local_storage_document_start_script("https://game.example.test", true, &entries)
                .unwrap();
        assert!(script.contains("globalThis.top !== globalThis"));
        assert!(script.contains("location.origin !== \"https://game.example.test\""));
        assert!(script.contains("localStorage.clear()"));
        assert!(script.contains("token\\\"</script>"));

        let restore = local_storage_restore_script(
            "https://game.example.test",
            &[("key".to_owned(), "old".to_owned())],
        )
        .unwrap();
        assert!(restore.contains("localStorage.clear()"));
        assert!(restore.contains("__rionSessionRestoreState"));
        assert!(validate_transaction_id("../escape").is_err());
        assert!(validate_transaction_id("transaction-1").is_ok());
    }

    #[test]
    fn session_transfer_omits_false_cookie_flags_and_preserves_true_flags() {
        let launch = Url::parse("https://game.example.test/play").unwrap();
        let plain = transfer_cookie(
            &SessionCookieRecord {
                name: "plain".to_owned(),
                value: "value".to_owned(),
                domain: Some(".example.test".to_owned()),
                path: "/".to_owned(),
                secure: false,
                http_only: false,
                same_site: "lax".to_owned(),
                expires_unix_ms: None,
            },
            &launch,
        )
        .unwrap();
        assert_eq!(plain.secure(), None);
        assert_eq!(plain.http_only(), None);

        let protected = transfer_cookie(
            &SessionCookieRecord {
                name: "protected".to_owned(),
                value: "value".to_owned(),
                domain: Some(".example.test".to_owned()),
                path: "/".to_owned(),
                secure: true,
                http_only: true,
                same_site: "strict".to_owned(),
                expires_unix_ms: None,
            },
            &launch,
        )
        .unwrap();
        assert_eq!(protected.secure(), Some(true));
        assert_eq!(protected.http_only(), Some(true));
    }

    #[test]
    fn session_transfer_cookie_scope_includes_parent_domains_and_valid_paths() {
        let launch = Url::parse("https://universe.flyff.com/play/character").unwrap();
        for domain in [".flyff.com", "flyff.com", "universe.flyff.com"] {
            let cookie = Cookie::build(("session", "value"))
                .domain(domain)
                .path("/play")
                .secure(true)
                .build();
            assert!(
                native_cookie_matches_launch(&cookie, &launch),
                "expected {domain} to match the launch URL"
            );
        }

        for (domain, path) in [
            ("account.flyff.com", "/play"),
            ("notflyff.com", "/play"),
            (".flyff.com", "/player"),
        ] {
            let cookie = Cookie::build(("session", "value"))
                .domain(domain)
                .path(path)
                .build();
            assert!(
                !native_cookie_matches_launch(&cookie, &launch),
                "did not expect {domain}{path} to match the launch URL"
            );
        }

        let secure_cookie = Cookie::build(("session", "value"))
            .domain(".flyff.com")
            .path("/")
            .secure(true)
            .build();
        let insecure_launch = Url::parse("http://universe.flyff.com/play").unwrap();
        assert!(!native_cookie_matches_launch(
            &secure_cookie,
            &insecure_launch
        ));
    }

    #[test]
    fn session_transfer_cookie_verification_normalizes_unspecified_same_site() {
        let unspecified = Cookie::build(("session", "value"))
            .domain("universe.flyff.com")
            .path("/")
            .build();
        let native_readback = Cookie::build(("session", "value"))
            .domain("universe.flyff.com")
            .path("/")
            .same_site(SameSite::None)
            .build();

        verify_cookie_readback(&[unspecified], &[native_readback]).unwrap();
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
            window_id: "window-7".to_owned(),
            display_id: 7,
            work_area: rion_core::StatePixelBoundsRecord {
                x: 100,
                y: 50,
                width: 1_200,
                height: 800,
            },
            bounds: rion_core::StatePixelBoundsRecord {
                x: 100,
                y: 50,
                width: 1_200,
                height: 800,
            },
            presentation: "normal".to_owned(),
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
    fn window_move_coordinates_remain_scaled_after_unlocked_native_queries() {
        for (platform, physical_x, physical_y, scale, expected) in [
            ("macos", 1_846, 60, 2.0, (923, 30)),
            ("windows", -300, 225, 1.5, (-200, 150)),
        ] {
            assert_eq!(
                logical_window_position(physical_x, physical_y, scale),
                expected,
                "unexpected logical position on {platform}"
            );
        }
    }

    #[test]
    fn native_window_query_runs_after_runtime_mutex_is_released() {
        let state = Mutex::new(41);
        let result = query_unlocked_snapshot(
            &state,
            |value| Some(*value),
            |snapshot| {
                assert!(state.try_lock().is_ok());
                snapshot + 1
            },
        );
        assert_eq!(result, Some(42));
    }

    #[test]
    fn runtime_host_visibility_policy_is_resolved_after_the_state_snapshot() {
        for (platform, reveal, retain_visibility, currently_visible, expected) in [
            ("macos", true, false, false, true),
            ("macos", false, true, true, true),
            ("windows", false, false, true, false),
            ("windows", false, true, false, false),
        ] {
            assert_eq!(
                runtime_host_should_be_visible(reveal, retain_visibility, currently_visible),
                expected,
                "unexpected runtime host visibility on {platform}"
            );
        }
    }

    #[test]
    fn native_font_script_uses_valid_escaped_css_and_skips_default_settings() {
        let default = serde_json::from_value::<GameBrowserSettingsRecord>(json!({
            "fonts": {"mode":"default","families":{}},
            "graphics": {"mode":"automatic"},
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
        assert!(source.contains("@media (prefers-reduced-motion:reduce)"));
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
            resolve_modifier_codes(&["primary".to_owned(), "ctrl".to_owned()], true).unwrap(),
            vec!["MetaLeft", "ControlLeft"]
        );
        assert!(!macos_key_dispatch_needs_settle(None, "role-a"));
        assert!(!macos_key_dispatch_needs_settle(Some("role-a"), "role-a"));
        assert!(macos_key_dispatch_needs_settle(Some("role-a"), "role-b"));
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn attestation_input_counts_wait_for_mouse_release() {
        let expected = AttestationInputCounts {
            key_down: 4,
            key_up: 3,
            held: 0,
            mouse_down: 1,
            mouse_up: 1,
        };
        let pending_release = json!({
            "keyDown": 4,
            "keyUp": 3,
            "heldCount": 0,
            "mouseDown": 1,
            "mouseUp": 0
        });
        let completed_release = json!({
            "keyDown": 4,
            "keyUp": 3,
            "heldCount": 0,
            "mouseDown": 1,
            "mouseUp": 1
        });

        assert!(!expected.matches(&pending_release));
        assert!(expected.matches(&completed_release));
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
    }

    #[test]
    fn window_and_role_zoom_layers_compose_and_clamp_on_both_platforms() {
        for platform in ["macos", "windows"] {
            assert_eq!(next_zoom_factor(1.0, "in", 0.25, 5.0), 1.1, "{platform}");
            assert_eq!(next_zoom_factor(1.0, "out", 0.25, 5.0), 0.9, "{platform}");
            assert_eq!(next_zoom_factor(0.33, "in", 0.25, 3.0), 0.43, "{platform}");
            assert_eq!(next_zoom_factor(1.8, "reset", 0.25, 5.0), 1.0, "{platform}");
            assert_eq!(next_zoom_factor(3.0, "in", 0.25, 3.0), 3.0, "{platform}");
            assert_eq!(effective_zoom_factor(1.25, 1.1), 1.375, "{platform}");
            assert_eq!(effective_zoom_factor(3.0, 2.0), 5.0, "{platform}");
            assert_eq!(effective_zoom_factor(0.25, 0.25), 0.25, "{platform}");
        }
    }

    #[test]
    fn role_zoom_shortcuts_cover_platform_modifiers_rows_numpad_and_repeats() {
        for platform in ["macos", "windows"] {
            let action = |key: &str, shift: bool, wrong_modifier: bool| match platform {
                "macos" => macos_role_zoom_action(
                    match key {
                        "0" => 29,
                        "numpad0" => 82,
                        "minus" => 27,
                        "numpadMinus" => 78,
                        "plus" => 24,
                        _ => 69,
                    },
                    true,
                    wrong_modifier,
                    false,
                    shift,
                ),
                _ => windows_role_zoom_action(
                    match key {
                        "0" => 0x30,
                        "numpad0" => 0x60,
                        "minus" => 0xBD,
                        "numpadMinus" => 0x6D,
                        "plus" => 0xBB,
                        _ => 0x6B,
                    },
                    true,
                    false,
                    wrong_modifier,
                    shift,
                ),
            };
            assert_eq!(action("0", false, false), Some("reset"), "{platform}");
            assert_eq!(action("numpad0", false, false), Some("reset"), "{platform}");
            assert_eq!(action("minus", false, false), Some("out"), "{platform}");
            assert_eq!(
                action("numpadMinus", false, false),
                Some("out"),
                "{platform}"
            );
            assert_eq!(action("plus", true, false), Some("in"), "{platform}");
            assert_eq!(action("numpadPlus", false, false), Some("in"), "{platform}");
            assert_eq!(action("0", false, true), None, "{platform}");
            assert_eq!(action("numpadPlus", true, false), None, "{platform}");
            for _repeat in 0..3 {
                assert_eq!(action("plus", false, false), Some("in"), "{platform}");
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_role_zoom_shortcut_responder_consumes_only_supported_combinations() {
        unsafe extern "C" {
            fn rion_wk_role_zoom_shortcut_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_role_zoom_shortcut_self_test() });
    }

    #[test]
    fn shared_runtime_indicators_are_isolated_and_reset_the_zoom_timer() {
        let source = runtime_indicator_document_start_script().unwrap();
        assert!(source.contains("rion-studio-runtime-indicators-v1"));
        assert!(source.contains("attachShadow({ mode: \"open\" })"));
        assert!(source.contains("__rionStudioWorkspaceResizeIndicator"));
        assert!(source.contains("__rionStudioZoomIndicator"));
        assert!(source.contains("clearTimeout(zoomTimer)"));
        assert!(source.contains("1200"));
        assert!(source.contains("element.remove()"));
        assert!(!source.contains(RUNTIME_INDICATOR_CSS_TOKEN));
    }

    #[test]
    fn role_zoom_persistence_is_last_write_wins() {
        let key = ("workspace-1".to_owned(), "role-1".to_owned());
        let mut pending = HashMap::from([(key.clone(), 2)]);
        assert!(!take_latest_role_zoom_write(&mut pending, &key, 1));
        assert_eq!(pending.get(&key), Some(&2));
        assert!(take_latest_role_zoom_write(&mut pending, &key, 2));
        assert!(!pending.contains_key(&key));
    }
}
