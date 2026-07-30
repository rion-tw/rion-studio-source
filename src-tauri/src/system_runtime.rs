#[cfg(windows)]
use std::cell::RefCell;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::watch;

use rion_core::{
    AppCore, BrowserAction, BrowserActionRequest, BrowserPerformanceDiagnosticStatus,
    BrowserPerformanceDiagnosticsRecord, BrowserPerformanceSurfaceDiagnosticRecord,
    BrowserRuntimeSnapshot, BrowserRuntimeWindowRecord, CoreCommand, CoreEffectAction,
    CoreEffectRequest, CoreEffectResult, DisplayTargetRecord, EmbeddedKeyEffectRecord,
    EmbeddedKeyTransitionRecord, EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord,
    EmbeddedTabEffectRecord, EngineCapabilitySnapshotRecord, EngineCapabilityStatus,
    GameBrowserSettingsRecord, GameWindowPlacementRecord, GameWindowRoleViewRecord,
    GameWindowUpdateInputRecord, HighRefreshRateDiagnosticStatus, LayoutBounds, LayoutDividerInput,
    LayoutRect, LayoutRoleInput, LogCaptureRecord, LogLevel, LogSource, ResolvedBrowserEngine,
    RuntimeRestoreSessionRecord, RuntimeRestoreTabRecord, RuntimeRestoreWindowRecord,
    SessionCookieRecord, SessionTransferPayloadRecord, StateGameRecord, StateGameWindowRecord,
    StateNormalizedRectRecord, StatePixelBoundsRecord, StateRoleRecord, StateWebGraphicsRecord,
    SystemWebViewRuntimeRegistrationRecord, WorkspaceAppearanceSettingsRecord,
    WorkspaceDividerDescriptor, WorkspaceDividerResizeInput, WorkspaceDividerResizeOutput,
    WorkspaceLayoutInput, WorkspaceLayoutOutput,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Url, Webview,
    WebviewUrl, WebviewWindowBuilder, Window,
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
const SURFACE_ISOLATION_TIMEOUT: Duration = Duration::from_secs(2);
const SURFACE_RECLAMATION_TIMEOUT: Duration = Duration::from_secs(10);
const NATIVE_PRESENTATION_COALESCE_INTERVAL: Duration = Duration::from_millis(8);
const PRESENTATION_PAINT_BARRIER_TIMEOUT: Duration = Duration::from_millis(50);
const OPTIONAL_HYDRATION_IDLE_INTERVAL: Duration = Duration::from_millis(500);
const SURFACE_RECOVERY_LIMIT: u8 = 2;
const SURFACE_RECOVERY_WINDOW: Duration = Duration::from_secs(60);
const LOCAL_STORAGE_SYNC_MAX_BYTES: usize = 10 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MACOS_KEY_DISPATCH_SETTLE_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(target_os = "macos")]
static MACOS_KEY_DISPATCH_STATE: std::sync::OnceLock<Mutex<Option<String>>> =
    std::sync::OnceLock::new();
static POPUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static DISPLAY_HOST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static SURFACE_INSTANCE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static ROLE_ZOOM_PERSIST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WINDOW_PLACEMENT_PERSIST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[cfg(windows)]
static WINDOWS_DOCUMENT_NAVIGATION_DEFERRAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[cfg(windows)]
thread_local! {
    // WebView2 delivers WebResourceRequested on its owning UI thread. Keep each
    // apartment-bound deferral on that thread, then resolve the token after
    // run_on_main_thread returns from the asynchronous macro-release command.
    // This also avoids adding an eager COM entry-point import to the process.
    static WINDOWS_DOCUMENT_NAVIGATION_DEFERRALS: RefCell<HashMap<
        u64,
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
    >> = RefCell::new(HashMap::new());
}
const WINDOW_PLACEMENT_PERSIST_DEBOUNCE: Duration = Duration::from_millis(180);
const DESIGN_TOKENS_CSS: &str = include_str!("../../src/shared/designTokens.css");
const MACRO_OVERLAY_RUNTIME_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/macroOverlayRuntime.js");
const MACRO_OVERLAY_CSS: &str = include_str!("../../src/shared/browser-overlay/macroOverlay.css");
const MACRO_OVERLAY_SHORTCUT_GUARD_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/macroOverlayShortcutGuard.js");
const MACRO_OVERLAY_BINDING_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_BINDING__";
const MACRO_OVERLAY_CAPABILITY_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_CAPABILITY__";
const MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__";
const MACRO_OVERLAY_TRUSTED_EVENT_GUARD_TOKEN: &str =
    "__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__";
const MACRO_OVERLAY_TRUSTED_EVENT_GUARD_SOURCE: &str = "(event) => event.isTrusted === true";
const MACRO_OVERLAY_CSS_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_CSS__";
const MACRO_OVERLAY_REFRESH_SOURCE: &str = "void globalThis.__rionStudioMacroOverlay?.refresh?.()";
const RUNTIME_INDICATOR_RUNTIME_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/runtimeIndicators.js");
const RUNTIME_INDICATOR_CSS: &str =
    include_str!("../../src/shared/browser-overlay/runtimeIndicators.css");
const RUNTIME_INDICATOR_CSS_TOKEN: &str = "__RION_STUDIO_RUNTIME_INDICATOR_CSS__";
const BROWSER_FONTS_RUNTIME_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/browserFontsRuntime.js");
const BROWSER_FONTS_REFRESH_SOURCE: &str = "void globalThis.__rionStudioBrowserFonts?.refresh?.()";
const SYSTEM_RUNTIME_INIT_SCRIPT: &str = r#"
(() => {
  Object.defineProperty(globalThis, "__rionSystemWebView", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ version: 1 })
  });

  const closeMessage = "__rion_native_surface_prepare_close_v1__";
  const beforeUnloadListeners = [];
  const eventTarget = globalThis.EventTarget?.prototype;
  const originalAddEventListener = eventTarget?.addEventListener;
  const originalRemoveEventListener = eventTarget?.removeEventListener;
  const captureValue = (options) => typeof options === "boolean"
    ? options
    : Boolean(options?.capture);

  if (originalAddEventListener && originalRemoveEventListener) {
    eventTarget.addEventListener = function(type, listener, options) {
      if (this === globalThis && type === "beforeunload" && listener) {
        beforeUnloadListeners.push({ listener, capture: captureValue(options) });
      }
      return Reflect.apply(originalAddEventListener, this, [type, listener, options]);
    };
    eventTarget.removeEventListener = function(type, listener, options) {
      if (this === globalThis && type === "beforeunload" && listener) {
        const capture = captureValue(options);
        for (let index = beforeUnloadListeners.length - 1; index >= 0; index -= 1) {
          const entry = beforeUnloadListeners[index];
          if (entry.listener === listener && entry.capture === capture) {
            beforeUnloadListeners.splice(index, 1);
          }
        }
      }
      return Reflect.apply(originalRemoveEventListener, this, [type, listener, options]);
    };
  }

  const prepareForNativeClose = () => {
    try { globalThis.onbeforeunload = null; } catch {}
    if (originalRemoveEventListener) {
      for (const entry of beforeUnloadListeners.splice(0)) {
        try {
          Reflect.apply(originalRemoveEventListener, globalThis, [
            "beforeunload",
            entry.listener,
            entry.capture
          ]);
        } catch {}
      }
    }
    for (let index = 0; index < globalThis.frames.length; index += 1) {
      try { globalThis.frames[index].postMessage(closeMessage, "*"); } catch {}
    }
  };

  if (originalAddEventListener) {
    Reflect.apply(originalAddEventListener, globalThis, ["message", (event) => {
      if (event.data === closeMessage) prepareForNativeClose();
    }, false]);
  }
  Object.defineProperty(globalThis, "__rionPrepareForNativeClose", {
    configurable: false,
    enumerable: false,
    value: prepareForNativeClose
  });
})();
"#;
const PERFORMANCE_DIAGNOSTIC_START_SOURCE: &str = r#"(() => {
  const key = "__rionStudioPerformanceDiagnostics";
  const previous = globalThis[key];
  if (previous && typeof previous.rafId === "number") cancelAnimationFrame(previous.rafId);
  try { previous?.longTaskObserver?.disconnect(); } catch {}
  const probe = {
    frameCount: 0,
    intervals: [],
    lastFrameAt: undefined,
    longTaskDurations: [],
    longTaskObserver: undefined,
    longTaskObserverSupported: false,
    rafId: undefined,
    running: true,
    startedAt: performance.now(),
    webgpu: "unavailable",
    webgpuError: undefined
  };
  globalThis[key] = probe;
  try {
    const supported = Array.isArray(globalThis.PerformanceObserver?.supportedEntryTypes)
      && globalThis.PerformanceObserver.supportedEntryTypes.includes("longtask");
    if (supported) {
      probe.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (probe.longTaskDurations.length >= 2048) break;
          if (Number.isFinite(entry.duration) && entry.duration >= 0) {
            probe.longTaskDurations.push(entry.duration);
          }
        }
      });
      probe.longTaskObserver.observe({ type: "longtask", buffered: false });
      probe.longTaskObserverSupported = true;
    }
  } catch {
    try { probe.longTaskObserver?.disconnect(); } catch {}
    probe.longTaskObserver = undefined;
    probe.longTaskObserverSupported = false;
  }
  if (navigator.gpu && typeof navigator.gpu.requestAdapter === "function") {
    probe.webgpu = "unknown";
    Promise.resolve(navigator.gpu.requestAdapter()).then((adapter) => {
      probe.webgpu = adapter ? "available" : "unavailable";
    }).catch((error) => {
      probe.webgpu = "unavailable";
      probe.webgpuError = error instanceof Error ? error.message : String(error);
    });
  }
  const tick = (now) => {
    if (!probe.running) return;
    if (typeof probe.lastFrameAt === "number" && probe.intervals.length < 2048) {
      probe.intervals.push(now - probe.lastFrameAt);
    }
    probe.lastFrameAt = now;
    probe.frameCount += 1;
    probe.rafId = requestAnimationFrame(tick);
  };
  probe.rafId = requestAnimationFrame(tick);
  return JSON.stringify({ started: true });
})()"#;
const PERFORMANCE_DIAGNOSTIC_READ_SOURCE: &str = r#"(() => {
  const key = "__rionStudioPerformanceDiagnostics";
  const probe = globalThis[key];
  if (!probe) return JSON.stringify({ error: "Performance sample was not started." });
  probe.running = false;
  if (typeof probe.rafId === "number") cancelAnimationFrame(probe.rafId);
  try {
    for (const entry of probe.longTaskObserver?.takeRecords?.() || []) {
      if (probe.longTaskDurations.length >= 2048) break;
      if (Number.isFinite(entry.duration) && entry.duration >= 0) {
        probe.longTaskDurations.push(entry.duration);
      }
    }
    probe.longTaskObserver?.disconnect();
  } catch {}
  const duration = Math.max(0, performance.now() - probe.startedAt);
  const intervals = [...probe.intervals].filter(Number.isFinite).sort((a, b) => a - b);
  const intervalDuration = intervals.reduce((total, interval) => total + interval, 0);
  const longTaskDurations = [...probe.longTaskDurations]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const percentile = (fraction) => intervals.length
    ? intervals[Math.min(intervals.length - 1, Math.floor((intervals.length - 1) * fraction))]
    : undefined;
  const graphics = { webgl: "unavailable", webgl2: "unavailable", webgpu: probe.webgpu || "unknown" };
  try {
    const canvas = document.createElement("canvas");
    const webgl2 = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    const webgl = webgl2 || canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true });
    graphics.webgl2 = webgl2 ? "available" : "unavailable";
    graphics.webgl = webgl ? "available" : "unavailable";
    if (webgl) {
      const extension = webgl.getExtension("WEBGL_debug_renderer_info");
      if (extension) {
        graphics.renderer = String(webgl.getParameter(extension.UNMASKED_RENDERER_WEBGL) || "");
        graphics.vendor = String(webgl.getParameter(extension.UNMASKED_VENDOR_WEBGL) || "");
      }
    }
  } catch (error) {
    graphics.error = error instanceof Error ? error.message : String(error);
  }
  if (probe.webgpuError) {
    graphics.error = graphics.error ? `${graphics.error}; ${probe.webgpuError}` : probe.webgpuError;
  }
  const visibility = ["visible", "hidden", "prerender"].includes(document.visibilityState)
    ? document.visibilityState
    : "unknown";
  const averageFps = intervalDuration > 0 && intervals.length > 0
    ? intervals.length * 1000 / intervalDuration
    : undefined;
  delete globalThis[key];
  return JSON.stringify({
    documentVisibilityState: visibility,
    documentHasFocus: document.hasFocus(),
    viewportWidth: Number.isFinite(innerWidth) ? innerWidth : 0,
    viewportHeight: Number.isFinite(innerHeight) ? innerHeight : 0,
    devicePixelRatio: Number.isFinite(globalThis.devicePixelRatio) ? globalThis.devicePixelRatio : 1,
    hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 0,
    frameCount: probe.frameCount,
    observedDurationMs: duration,
    averageFps,
    frameIntervalsMs: intervals,
    p50FrameIntervalMs: percentile(0.5),
    p95FrameIntervalMs: percentile(0.95),
    p99FrameIntervalMs: percentile(0.99),
    longestFrameIntervalMs: intervals.at(-1),
    ...(probe.longTaskObserverSupported ? {
      longTaskCount: longTaskDurations.length,
      longTaskTotalDurationMs: longTaskDurations.reduce((total, value) => total + value, 0),
      longestTaskMs: longTaskDurations.at(-1) || 0
    } : {}),
    graphics
  });
})()"#;
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
#[cfg(windows)]
const WINDOWS_RUNTIME_TAB_RESERVATION_SCRIPT: &str = r#"
(() => {
  globalThis.__rionPendingRuntimeTabs ??= [];
  globalThis.__rionReserveRuntimeTab ??= (tab) => {
    globalThis.__rionPendingRuntimeTabs.push(tab);
  };
  globalThis.__rionRemoveRuntimeTab ??= (tabId) => {
    globalThis.__rionPendingRuntimeTabs = globalThis.__rionPendingRuntimeTabs
      .filter((tab) => tab.id !== tabId);
  };
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
const TAURI_MACRO_OVERLAY_BRIDGE_SOURCE: &str =
    include_str!("../../src/shared/browser-overlay/macroOverlayNativeBridge.js");

#[derive(Default)]
struct NavigationState {
    finished: bool,
    started: bool,
}

struct NavigationTracker {
    state: Mutex<NavigationState>,
    changed: Condvar,
    async_changed: watch::Sender<bool>,
}

impl Default for NavigationTracker {
    fn default() -> Self {
        let (async_changed, _) = watch::channel(false);
        Self {
            state: Mutex::new(NavigationState::default()),
            changed: Condvar::new(),
            async_changed,
        }
    }
}

impl NavigationTracker {
    fn reset(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.finished = false;
            state.started = false;
        }
        self.async_changed.send_replace(false);
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
            if state.finished {
                self.async_changed.send_replace(true);
            }
        }
    }

    async fn wait_async(&self) -> Result<(), String> {
        let mut changed = self.async_changed.subscribe();
        if *changed.borrow_and_update() {
            return Ok(());
        }
        tokio::time::timeout(NAVIGATION_TIMEOUT, async move {
            loop {
                changed
                    .changed()
                    .await
                    .map_err(|_| "System WebView navigation tracker stopped.".to_owned())?;
                if *changed.borrow_and_update() {
                    return Ok(());
                }
            }
        })
        .await
        .map_err(|_| "System WebView navigation timed out.".to_owned())?
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
    generation: u64,
    high_refresh_rate_status: HighRefreshRateDiagnosticStatus,
    lifecycle: Arc<SurfaceLifecycleTracker>,
    local_storage_sync: Option<LocalStorageRuntimeConfig>,
    local_storage_sync_sequence: u64,
    navigation: Arc<NavigationTracker>,
    rect: rion_core::StateNormalizedRectRecord,
    surface_instance_id: String,
    webview: Webview,
    zoom_factor: f64,
    zoom_mode: String,
}

struct ReleasedRoleSurface {
    role_id: String,
    surface_instance_id: String,
    tab_id: String,
    webview_label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SurfaceCloseOutcome {
    isolated: bool,
    released: bool,
}

#[derive(Default)]
struct SurfaceReleaseState {
    #[cfg_attr(not(windows), allow(dead_code))]
    browser_process_exited: bool,
    controller_released: bool,
    isolated: bool,
    native_surface_released: bool,
}

#[derive(Default)]
struct SurfaceLifecycleTracker {
    #[cfg(windows)]
    browser_process_id: AtomicU64,
    #[cfg(windows)]
    controller_identity: AtomicU64,
    #[cfg(target_os = "macos")]
    native_token: AtomicU64,
    changed: Condvar,
    release: Mutex<SurfaceReleaseState>,
}

impl SurfaceLifecycleTracker {
    fn mark_isolated(&self) {
        if let Ok(mut release) = self.release.lock() {
            release.isolated = true;
            self.changed.notify_all();
        }
    }

    fn wait_for_isolation(&self, timeout: Duration) -> bool {
        self.wait_for(timeout, |release| {
            release.isolated || release.native_surface_released
        })
    }

    #[cfg(windows)]
    fn mark_browser_process_exited(&self) {
        if let Ok(mut release) = self.release.lock() {
            release.browser_process_exited = true;
            release.native_surface_released = true;
            self.changed.notify_all();
        }
    }

    fn mark_controller_released(&self) {
        if let Ok(mut release) = self.release.lock() {
            release.controller_released = true;
            self.changed.notify_all();
        }
    }

    fn mark_native_surface_released(&self) {
        if let Ok(mut release) = self.release.lock() {
            release.isolated = true;
            release.native_surface_released = true;
            self.changed.notify_all();
        }
    }

    fn native_surface_is_released(&self) -> bool {
        self.release
            .lock()
            .map(|release| release.native_surface_released)
            .unwrap_or(false)
    }

    fn wait_for_controller_release(&self, platform: &str, timeout: Duration) -> bool {
        self.wait_for(timeout, |release| {
            surface_release_complete(platform, release)
        })
    }

    #[cfg(all(windows, test))]
    fn wait_for_browser_process_exit(&self, timeout: Duration) -> bool {
        self.wait_for(timeout, |release| release.browser_process_exited)
    }

    fn wait_for(&self, timeout: Duration, complete: impl Fn(&SurfaceReleaseState) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut release) = self.release.lock() else {
            return false;
        };
        while !complete(&release) {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let Ok((next, timeout)) = self
                .changed
                .wait_timeout(release, deadline.saturating_duration_since(now))
            else {
                return false;
            };
            release = next;
            if timeout.timed_out() && !complete(&release) {
                return false;
            }
        }
        true
    }
}

fn surface_release_complete(platform: &str, release: &SurfaceReleaseState) -> bool {
    match platform {
        "windows" => release.controller_released && release.native_surface_released,
        "macos" => release.controller_released && release.native_surface_released,
        _ => release.controller_released,
    }
}

#[cfg(any(windows, test))]
fn windows_surface_identity_matches(
    expected_controller: u64,
    actual_controller: u64,
    expected_process_id: u32,
    actual_process_id: u32,
) -> bool {
    expected_controller != 0
        && expected_controller == actual_controller
        && expected_process_id != 0
        && expected_process_id == actual_process_id
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedSurfaceKind {
    Divider,
    Popup,
    Recovery,
    Role,
}

impl ManagedSurfaceKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Divider => "divider",
            Self::Popup => "popup",
            Self::Recovery => "recovery",
            Self::Role => "role",
        }
    }
}

const fn managed_surface_close_priority(kind: ManagedSurfaceKind) -> u8 {
    match kind {
        ManagedSurfaceKind::Popup => 0,
        ManagedSurfaceKind::Recovery => 1,
        ManagedSurfaceKind::Role => 2,
        ManagedSurfaceKind::Divider => 3,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedSurfacePhase {
    Live,
    CloseRequested,
    Isolating,
    Isolated,
    Provisional,
    Quarantined,
    Releasing,
    Released,
    Retired,
}

impl ManagedSurfacePhase {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::CloseRequested => "closeRequested",
            Self::Isolating => "isolating",
            Self::Isolated => "isolated",
            Self::Provisional => "provisional",
            Self::Quarantined => "quarantined",
            Self::Releasing => "releasing",
            Self::Released => "released",
            Self::Retired => "retired",
        }
    }
}

impl ManagedSurfacePhase {
    const fn blocks_role_relaunch(self) -> bool {
        matches!(
            self,
            Self::Live
                | Self::CloseRequested
                | Self::Isolating
                | Self::Provisional
                | Self::Quarantined
        )
    }
}

#[derive(Clone)]
struct ManagedSurface {
    close_started_at: Option<Instant>,
    generation: u64,
    instance_id: String,
    kind: ManagedSurfaceKind,
    lifecycle: Arc<SurfaceLifecycleTracker>,
    native_lifecycle_lane: Arc<Mutex<()>>,
    phase: ManagedSurfacePhase,
    role_id: Option<String>,
    tab_id: Option<String>,
    webview: Webview,
    window_id: String,
}

fn next_surface_instance_id(label: &str) -> String {
    let sequence = SURFACE_INSTANCE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{label}:{sequence}")
}

fn surface_generation_is_current(active: u64, reported: u64) -> bool {
    active == reported
}

fn surface_recovery_swap_is_current(
    active_label: &str,
    expected_label: &str,
    active_generation: u64,
    expected_generation: u64,
) -> bool {
    active_label == expected_label
        && surface_generation_is_current(active_generation, expected_generation)
}

fn surface_close_commit_is_current(
    active_tab_id: &str,
    expected_tab_id: &str,
    active_label: &str,
    closed_label: &str,
) -> bool {
    active_tab_id == expected_tab_id && active_label == closed_label
}

fn provisional_move_failure_message(original: String, rollback_errors: &[String]) -> String {
    if rollback_errors.is_empty() {
        original
    } else {
        format!(
            "SYSTEM_PROVISIONAL_MOVE_ROLLBACK_FAILED: {original} Compensation failed: {}. Restart Rion Studio to recover safely.",
            rollback_errors.join("; ")
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ReversibleFanoutFailure {
    apply_error: String,
    rollback_errors: Vec<String>,
}

fn rollback_reversible_fanout<T>(
    items: &[T],
    mut rollback: impl FnMut(usize, &T) -> Result<(), String>,
) -> Vec<String> {
    (0..items.len())
        .rev()
        .filter_map(|index| rollback(index, &items[index]).err())
        .collect()
}

fn apply_reversible_fanout<T>(
    items: &[T],
    mut apply: impl FnMut(usize, &T) -> Result<(), String>,
    mut rollback: impl FnMut(usize, &T) -> Result<(), String>,
) -> Result<(), ReversibleFanoutFailure> {
    for (index, item) in items.iter().enumerate() {
        if let Err(apply_error) = apply(index, item) {
            let rollback_errors = (0..=index)
                .rev()
                .filter_map(|rollback_index| rollback(rollback_index, &items[rollback_index]).err())
                .collect();
            return Err(ReversibleFanoutFailure {
                apply_error,
                rollback_errors,
            });
        }
    }
    Ok(())
}

fn reversible_fanout_runtime_error(
    apply_code: &'static str,
    operation: &str,
    failure: &ReversibleFanoutFailure,
) -> RuntimeError {
    if failure.rollback_errors.is_empty() {
        RuntimeError::new(apply_code, failure.apply_error.clone())
    } else {
        RuntimeError::new(
            "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED",
            format!(
                "{operation} failed: {} Compensation also failed: {}. Restart Rion Studio to recover safely.",
                failure.apply_error,
                failure.rollback_errors.join("; ")
            ),
        )
    }
}

fn apply_window_close_to_hide_transaction(
    persist_placement: impl FnOnce() -> Result<(), String>,
    hide: impl FnOnce() -> Result<(), String>,
    persist_restore_session: impl FnOnce() -> Result<(), String>,
    restore_visibility: impl FnOnce() -> Result<(), String>,
) -> Result<(), ReversibleFanoutFailure> {
    persist_placement().map_err(|apply_error| ReversibleFanoutFailure {
        apply_error,
        rollback_errors: Vec::new(),
    })?;

    if let Err(apply_error) = hide() {
        return Err(ReversibleFanoutFailure {
            apply_error,
            rollback_errors: restore_visibility().err().into_iter().collect(),
        });
    }
    if let Err(apply_error) = persist_restore_session() {
        return Err(ReversibleFanoutFailure {
            apply_error,
            rollback_errors: restore_visibility().err().into_iter().collect(),
        });
    }
    Ok(())
}

fn finalize_persisted_effect_result(
    mut result: CoreEffectResult,
    persist_runtime: bool,
    persistence_error: Option<String>,
) -> CoreEffectResult {
    if result.ok
        && persist_runtime
        && let Some(message) = persistence_error
    {
        result.ok = false;
        result.value_json = None;
        result.error = Some(rion_core::CoreErrorPayload {
            code: "SYSTEM_RUNTIME_PERSIST_FAILED".to_owned(),
            message: format!(
                "The native runtime changed, but its restore session could not be persisted: {message}"
            ),
        });
    }
    result
}

fn successor_tab_after_close(
    ordered_tab_ids: &[String],
    closing_tab_id: &str,
    mut selectable: impl FnMut(&str) -> bool,
) -> Option<String> {
    let closing_index = ordered_tab_ids
        .iter()
        .position(|tab_id| tab_id == closing_tab_id)?;
    ordered_tab_ids
        .iter()
        .skip(closing_index + 1)
        .chain(ordered_tab_ids[..closing_index].iter().rev())
        .find(|tab_id| selectable(tab_id))
        .cloned()
}

fn accept_local_storage_sync_sequence(last_accepted: &mut u64, incoming: u64) -> bool {
    if incoming == 0 || incoming <= *last_accepted {
        return false;
    }
    *last_accepted = incoming;
    true
}

fn claim_surface_recovery(
    active_generation: u64,
    reported_generation: u64,
    recovering_roles: &mut HashSet<String>,
    role_id: &str,
) -> bool {
    surface_generation_is_current(active_generation, reported_generation)
        && recovering_roles.insert(role_id.to_owned())
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SurfaceFailureTarget {
    Role {
        role_id: String,
        generation: u64,
    },
    Popup {
        label: String,
        role_id: String,
        generation: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SurfaceFailureScope {
    Renderer,
    #[cfg_attr(not(windows), allow(dead_code))]
    Browser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SurfaceFailureAction {
    RecoverRole,
    ClosePopup,
}

fn surface_failure_action(
    target: &SurfaceFailureTarget,
    scope: SurfaceFailureScope,
) -> SurfaceFailureAction {
    if matches!(target, SurfaceFailureTarget::Popup { .. })
        && scope == SurfaceFailureScope::Renderer
    {
        SurfaceFailureAction::ClosePopup
    } else {
        SurfaceFailureAction::RecoverRole
    }
}

#[derive(Clone, PartialEq, Eq)]
struct LocalStorageRuntimeConfig {
    dependent_role_ids: Vec<String>,
    generation: u64,
    keys: Vec<String>,
    origin: String,
    source_role_id: Option<String>,
    token: String,
}

struct LocalStorageMetadataUpdate {
    apply_scripts: Vec<String>,
    next: Option<LocalStorageRuntimeConfig>,
    previous: Option<LocalStorageRuntimeConfig>,
    role_id: String,
    rollback_scripts: Vec<String>,
    webview: Webview,
    webview_label: String,
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
    #[cfg(target_os = "macos")]
    workspace_template: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchPhase {
    Attaching,
    Navigating,
    EssentialReady,
    OptionalHydrating,
    Ready,
    Degraded,
}

impl LaunchPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attaching => "attaching",
            Self::Navigating => "navigating",
            Self::EssentialReady => "essentialReady",
            Self::OptionalHydrating => "optionalHydrating",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
        }
    }

    fn blocks_optional_idle(self) -> bool {
        matches!(self, Self::Attaching | Self::Navigating)
    }
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
    surface_instance_id: String,
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
struct CloseCoordinator {
    closing_roles: HashSet<String>,
    closing_tabs: HashSet<String>,
    closing_webviews: HashSet<String>,
    quarantined_roles: HashSet<String>,
}

#[derive(Default)]
struct PresentationRegistry {
    actors: Mutex<HashMap<String, Arc<NativeWindowActor>>>,
    next_revision: AtomicU64,
    windows: Mutex<HashMap<String, Arc<Mutex<WindowPresentationState>>>>,
}

struct NativePresentationRequest {
    active_webview: Option<Webview>,
    coordinator: Arc<Mutex<WindowPresentationState>>,
    core: Arc<AppCore>,
    focus: bool,
    next_surface_identities: HashSet<(String, u64)>,
    next_surfaces: Vec<Webview>,
    observed_previous_tab_id: Option<String>,
    observed_previous_surfaces: Vec<Webview>,
    requested_at: Instant,
    revision: u64,
    tab_id: Option<String>,
    trigger: &'static str,
    window: Window,
    window_id: String,
    window_visibility: Option<bool>,
}

struct NativePresentationBatch {
    first_requested_at: Instant,
    first_revision: u64,
    request: NativePresentationRequest,
    request_count: u32,
}

struct NativePresentationOutcome {
    applied: bool,
    focus_applied: bool,
    hidden_surface_count: usize,
    main_queue_wait_ms: u64,
    main_thread_ms: u64,
    shown_surface_count: usize,
    visibility_errors: Vec<String>,
}

struct LatestOnlyPresentationQueue<T> {
    in_flight: bool,
    pending: Option<T>,
}

impl<T> Default for LatestOnlyPresentationQueue<T> {
    fn default() -> Self {
        Self {
            in_flight: false,
            pending: None,
        }
    }
}

impl<T> LatestOnlyPresentationQueue<T> {
    fn replace(&mut self, value: T) {
        self.pending = Some(value);
    }

    fn begin_latest(&mut self) -> Option<T> {
        if self.in_flight {
            return None;
        }
        let latest = self.pending.take()?;
        self.in_flight = true;
        Some(latest)
    }

    fn finish(&mut self) {
        self.in_flight = false;
    }
}

#[derive(Default)]
struct NativeWindowActorState {
    applied_revision: u64,
    applied_surfaces: Vec<Webview>,
    applied_tab_id: Option<String>,
    burst_first_requested_at: Option<Instant>,
    burst_first_revision: u64,
    burst_request_count: u32,
    requests: LatestOnlyPresentationQueue<NativePresentationRequest>,
    stopped: bool,
}

struct NativeWindowActor {
    queue: Arc<(Mutex<NativeWindowActorState>, Condvar)>,
}

impl NativeWindowActor {
    fn start(window_id: &str) -> Result<Arc<Self>, String> {
        let queue = Arc::new((
            Mutex::new(NativeWindowActorState::default()),
            Condvar::new(),
        ));
        let worker_queue = Arc::clone(&queue);
        std::thread::Builder::new()
            .name(format!("rion-native-window-{window_id}"))
            .spawn(move || {
                loop {
                    let batch = {
                        let (lock, changed) = &*worker_queue;
                        let Ok(mut state) = lock.lock() else {
                            return;
                        };
                        while state.requests.pending.is_none() && !state.stopped {
                            let Ok(next) = changed.wait(state) else {
                                return;
                            };
                            state = next;
                        }
                        if state.stopped {
                            return;
                        }
                        let mut observed_revision = state
                            .requests
                            .pending
                            .as_ref()
                            .map(|request| request.revision)
                            .unwrap_or(0);
                        loop {
                            let Ok((next, timeout)) =
                                changed.wait_timeout(state, NATIVE_PRESENTATION_COALESCE_INTERVAL)
                            else {
                                return;
                            };
                            state = next;
                            if state.stopped {
                                return;
                            }
                            let latest_revision = state
                                .requests
                                .pending
                                .as_ref()
                                .map(|request| request.revision)
                                .unwrap_or(0);
                            if latest_revision != observed_revision {
                                observed_revision = latest_revision;
                                continue;
                            }
                            if timeout.timed_out() {
                                break;
                            }
                        }
                        let Some(request) = state.requests.begin_latest() else {
                            continue;
                        };
                        if let Ok(mut coordinator) = request.coordinator.lock() {
                            coordinator.scheduled = false;
                            coordinator.in_flight = true;
                        }
                        Some(NativePresentationBatch {
                            first_requested_at: state
                                .burst_first_requested_at
                                .take()
                                .unwrap_or(request.requested_at),
                            first_revision: std::mem::take(&mut state.burst_first_revision),
                            request,
                            request_count: std::mem::take(&mut state.burst_request_count),
                        })
                    };
                    let Some(batch) = batch else {
                        continue;
                    };
                    let previous = worker_queue
                        .0
                        .lock()
                        .ok()
                        .map(|state| (state.applied_tab_id.clone(), state.applied_surfaces.clone()))
                        .unwrap_or_default();
                    let outcome =
                        apply_native_presentation_batch(&batch.request, &previous.0, previous.1);
                    let (lock, changed) = &*worker_queue;
                    let Ok(mut state) = lock.lock() else {
                        return;
                    };
                    if outcome.applied {
                        state.applied_revision = batch.request.revision;
                        state.applied_tab_id = batch.request.tab_id.clone();
                        state.applied_surfaces = batch.request.next_surfaces.clone();
                    }
                    state.requests.finish();
                    let has_pending = state.requests.pending.is_some();
                    if let Ok(mut coordinator) = batch.request.coordinator.lock() {
                        coordinator.in_flight = false;
                        coordinator.scheduled = has_pending;
                        if outcome.applied {
                            coordinator.applied_revision = batch.request.revision;
                            coordinator.applied_tab_id = batch.request.tab_id.clone();
                        }
                    }
                    changed.notify_one();
                    drop(state);
                    capture_presentation_batch_events(&batch, &outcome);
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(Self { queue }))
    }

    fn dispatch(&self, request: NativePresentationRequest) -> Result<(), String> {
        let (lock, changed) = &*self.queue;
        let mut state = lock
            .lock()
            .map_err(|_| "The native window actor is unavailable.".to_owned())?;
        if state.stopped {
            return Err("The native window actor has stopped.".to_owned());
        }
        if state.applied_revision == 0
            && !state.requests.in_flight
            && state.requests.pending.is_none()
            && state.applied_surfaces.is_empty()
        {
            state.applied_tab_id = request.observed_previous_tab_id.clone();
            state.applied_surfaces = request.observed_previous_surfaces.clone();
        }
        if state.requests.pending.is_none() {
            state.burst_first_requested_at = Some(request.requested_at);
            state.burst_first_revision = request.revision;
            state.burst_request_count = 1;
        } else {
            state.burst_request_count = state.burst_request_count.saturating_add(1);
        }
        if let Ok(mut coordinator) = request.coordinator.lock() {
            coordinator.scheduled = true;
        }
        // The only pending destination is replaced in-place. The worker does not dequeue it
        // until one short frame-coalescing interval has elapsed and the previous native batch
        // has actually completed on the UI thread.
        state.requests.replace(request);
        changed.notify_one();
        Ok(())
    }

    fn wait_until_applied(&self, revision: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let (lock, changed) = &*self.queue;
        let Ok(mut state) = lock.lock() else {
            return false;
        };
        while state.applied_revision < revision && !state.stopped {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let Ok((next, wait)) = changed.wait_timeout(state, remaining) else {
                return false;
            };
            state = next;
            if wait.timed_out() && state.applied_revision < revision {
                return false;
            }
        }
        state.applied_revision >= revision
    }

    fn stop(&self) {
        let (lock, changed) = &*self.queue;
        if let Ok(mut state) = lock.lock() {
            state.stopped = true;
            state.requests.pending = None;
            changed.notify_all();
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TabPresentationPhase {
    Reserved,
    Attaching,
    Loading,
    Ready,
    Degraded,
    Failed,
}

impl TabPresentationPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Attaching => "attaching",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone)]
struct TabPresentation {
    closable: bool,
    icon_data_url: Option<String>,
    id: String,
    phase: TabPresentationPhase,
    source_id: String,
    tab_type: String,
    title: String,
    #[cfg(target_os = "macos")]
    workspace_template: Option<String>,
}

#[derive(Clone)]
struct SurfacePresentationBinding {
    generation: u64,
    instance_id: String,
    webview: Webview,
}

#[derive(Clone, Default)]
struct WindowPresentationState {
    aliases: HashMap<String, String>,
    applied_tab_id: Option<String>,
    applied_revision: u64,
    host_visibility: bool,
    in_flight: bool,
    revision: u64,
    scheduled: bool,
    selected_tab_id: Option<String>,
    surface_bindings: HashMap<String, Vec<SurfacePresentationBinding>>,
    tabs: Vec<TabPresentation>,
}

impl WindowPresentationState {
    fn tab_ids(&self) -> Vec<String> {
        self.tabs.iter().map(|tab| tab.id.clone()).collect()
    }

    fn contains_tab(&self, tab_id: &str) -> bool {
        self.tabs.iter().any(|tab| tab.id == tab_id)
    }

    fn insert_tab(&mut self, tab: TabPresentation, revision: u64, select: bool) {
        let id = tab.id.clone();
        if let Some(existing) = self.tabs.iter_mut().find(|existing| existing.id == id) {
            *existing = tab;
        } else {
            self.tabs.push(tab);
        }
        if select {
            self.select(Some(id), revision);
        }
    }

    fn replace_tab_id(&mut self, provisional_id: &str, mut tab: TabPresentation, revision: u64) {
        let selected_provisional = self.selected_tab_id.as_deref() == Some(provisional_id);
        if let Some(index) = self.tabs.iter().position(|item| item.id == provisional_id) {
            self.aliases
                .insert(provisional_id.to_owned(), tab.id.clone());
            let previous_bindings = self.surface_bindings.remove(provisional_id);
            let replacement_id = tab.id.clone();
            self.tabs[index] = tab;
            if let Some(bindings) = previous_bindings {
                self.surface_bindings
                    .insert(replacement_id.clone(), bindings);
            }
            if selected_provisional {
                self.select(Some(replacement_id), revision);
            }
        } else {
            tab.phase = TabPresentationPhase::Attaching;
            self.insert_tab(tab, revision, false);
        }
    }

    fn remove_tab(&mut self, tab_id: &str, revision: u64) -> bool {
        let existed = self.tabs.iter().any(|tab| tab.id == tab_id);
        self.tabs.retain(|tab| tab.id != tab_id);
        self.surface_bindings.remove(tab_id);
        self.aliases
            .retain(|alias, target| alias != tab_id && target != tab_id);
        if self.selected_tab_id.as_deref() == Some(tab_id) {
            self.select(None, revision);
        }
        existed
    }

    fn select(&mut self, tab_id: Option<String>, revision: u64) {
        self.revision = revision;
        self.host_visibility = tab_id.is_some();
        self.selected_tab_id = tab_id;
    }

    fn update_phase(&mut self, tab_id: &str, phase: TabPresentationPhase) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.phase = phase;
        }
    }

    fn update_metadata(&mut self, tab_id: &str, source_id: &str, tab_type: &str, title: &str) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.source_id = source_id.to_owned();
            tab.tab_type = tab_type.to_owned();
            tab.title = title.to_owned();
        }
    }

    fn reorder_known_tabs(&mut self, ordered_tab_ids: &[String]) {
        let mut positions = ordered_tab_ids
            .iter()
            .enumerate()
            .map(|(index, tab_id)| (tab_id.as_str(), index))
            .collect::<HashMap<_, _>>();
        let fallback = ordered_tab_ids.len();
        self.tabs
            .sort_by_key(|tab| positions.remove(tab.id.as_str()).unwrap_or(fallback));
    }

    fn bind_surface(&mut self, tab_id: &str, binding: SurfacePresentationBinding) -> bool {
        if !self.contains_tab(tab_id) {
            return false;
        }
        let bindings = self.surface_bindings.entry(tab_id.to_owned()).or_default();
        if let Some(existing) = bindings
            .iter_mut()
            .find(|existing| existing.instance_id == binding.instance_id)
        {
            *existing = binding;
        } else {
            bindings.push(binding);
        }
        true
    }

    fn unbind_surface(&mut self, instance_id: &str) -> bool {
        let mut removed = false;
        self.surface_bindings.retain(|_, bindings| {
            let previous_len = bindings.len();
            bindings.retain(|binding| binding.instance_id != instance_id);
            removed |= previous_len != bindings.len();
            !bindings.is_empty()
        });
        removed
    }

    fn surfaces(&self, tab_id: Option<&str>) -> Vec<Webview> {
        tab_id
            .and_then(|tab_id| self.surface_bindings.get(tab_id))
            .map(|bindings| {
                bindings
                    .iter()
                    .filter(|binding| !binding.instance_id.is_empty())
                    .map(|binding| binding.webview.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn surface_identities(&self, tab_id: Option<&str>) -> HashSet<(String, u64)> {
        tab_id
            .and_then(|tab_id| self.surface_bindings.get(tab_id))
            .map(|bindings| {
                bindings
                    .iter()
                    .map(|binding| (binding.instance_id.clone(), binding.generation))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Clone)]
struct ProvisionalLaunch {
    cancelled: bool,
    host_created: bool,
    id: String,
    source_id: String,
    tab_type: String,
    window_id: String,
}

impl PresentationRegistry {
    fn next_revision(&self) -> u64 {
        self.next_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1)
    }

    fn current_revision(&self) -> u64 {
        self.next_revision.load(Ordering::Acquire)
    }

    fn coordinator(&self, window_id: &str) -> Result<Arc<Mutex<WindowPresentationState>>, String> {
        let mut windows = self
            .windows
            .lock()
            .map_err(|_| "The runtime tab presentation registry is unavailable.".to_owned())?;
        Ok(Arc::clone(
            windows
                .entry(window_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(WindowPresentationState::default()))),
        ))
    }

    fn existing(&self, window_id: &str) -> Option<Arc<Mutex<WindowPresentationState>>> {
        self.windows
            .lock()
            .ok()
            .and_then(|windows| windows.get(window_id).cloned())
    }

    fn resolve_tab_alias(&self, tab_id: &str) -> Option<String> {
        self.windows.lock().ok().and_then(|windows| {
            windows.values().find_map(|window| {
                window
                    .lock()
                    .ok()
                    .and_then(|selection| selection.aliases.get(tab_id).cloned())
            })
        })
    }

    fn selected_tabs(&self) -> HashMap<String, String> {
        self.windows
            .lock()
            .ok()
            .map(|windows| {
                windows
                    .iter()
                    .filter_map(|(window_id, state)| {
                        state
                            .lock()
                            .ok()
                            .and_then(|state| state.selected_tab_id.clone())
                            .map(|tab_id| (window_id.clone(), tab_id))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn window_contains_tab(&self, window_id: &str, tab_id: &str) -> bool {
        self.existing(window_id)
            .and_then(|state| state.lock().ok().map(|state| state.contains_tab(tab_id)))
            .unwrap_or(false)
    }

    fn tab(&self, window_id: &str, tab_id: &str) -> Option<TabPresentation> {
        self.existing(window_id).and_then(|state| {
            state
                .lock()
                .ok()
                .and_then(|state| state.tabs.iter().find(|tab| tab.id == tab_id).cloned())
        })
    }

    fn tab_for_source(&self, source_id: &str, tab_type: &str) -> Option<String> {
        self.windows.lock().ok().and_then(|windows| {
            windows.values().find_map(|window| {
                window.lock().ok().and_then(|state| {
                    state
                        .tabs
                        .iter()
                        .find(|tab| tab.source_id == source_id && tab.tab_type == tab_type)
                        .map(|tab| tab.id.clone())
                })
            })
        })
    }

    fn actor(&self, window_id: &str) -> Result<Arc<NativeWindowActor>, String> {
        let mut actors = self
            .actors
            .lock()
            .map_err(|_| "The native window actor registry is unavailable.".to_owned())?;
        if let Some(actor) = actors.get(window_id) {
            return Ok(Arc::clone(actor));
        }
        let actor = NativeWindowActor::start(window_id)?;
        actors.insert(window_id.to_owned(), Arc::clone(&actor));
        Ok(actor)
    }

    fn move_tab(
        &self,
        tab_id: &str,
        source_window_id: &str,
        target_window_id: &str,
        revision: u64,
    ) -> Result<(), String> {
        if source_window_id == target_window_id {
            return Ok(());
        }
        let source = self
            .existing(source_window_id)
            .ok_or_else(|| "The source presentation state was not found.".to_owned())?;
        let target = self.coordinator(target_window_id)?;
        let (tab, bindings, was_selected) = {
            let mut source = source
                .lock()
                .map_err(|_| "The source presentation state is unavailable.".to_owned())?;
            let index = source
                .tabs
                .iter()
                .position(|tab| tab.id == tab_id)
                .ok_or_else(|| "The moving presentation tab was not found.".to_owned())?;
            let was_selected = source.selected_tab_id.as_deref() == Some(tab_id);
            let successor = was_selected
                .then(|| successor_tab_after_close(&source.tab_ids(), tab_id, |_| true))
                .flatten();
            let tab = source.tabs.remove(index);
            let bindings = source.surface_bindings.remove(tab_id).unwrap_or_default();
            source
                .aliases
                .retain(|alias, target| alias != tab_id && target != tab_id);
            if was_selected {
                source.select(successor, revision);
            }
            (tab, bindings, was_selected)
        };
        let mut target = target
            .lock()
            .map_err(|_| "The target presentation state is unavailable.".to_owned())?;
        if !target.contains_tab(tab_id) {
            target.tabs.push(tab);
        }
        if !bindings.is_empty() {
            target.surface_bindings.insert(tab_id.to_owned(), bindings);
        }
        if was_selected {
            target.select(Some(tab_id.to_owned()), revision);
        }
        Ok(())
    }

    fn unbind_surface(&self, instance_id: &str) {
        let windows = self
            .windows
            .lock()
            .ok()
            .map(|windows| windows.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for window in windows {
            if let Ok(mut window) = window.lock()
                && window.unbind_surface(instance_id)
            {
                break;
            }
        }
    }

    fn remove(&self, window_id: &str) {
        if let Ok(mut windows) = self.windows.lock() {
            windows.remove(window_id);
        }
        if let Ok(mut actors) = self.actors.lock()
            && let Some(actor) = actors.remove(window_id)
        {
            actor.stop();
        }
    }
}

#[derive(Default)]
struct RuntimeState {
    active_window_placement_workers: HashSet<String>,
    active_window_resize_workers: HashSet<String>,
    allow_window_close_labels: HashSet<String>,
    audible_webviews: HashMap<String, bool>,
    auto_restore_attempted: bool,
    close_coordinator: CloseCoordinator,
    controlled_navigation_webviews: HashSet<String>,
    dormant_windows: Vec<RuntimeRestoreWindowRecord>,
    launch_phases: HashMap<String, LaunchPhase>,
    pending_macro_page_request: Option<Value>,
    close_previews: HashMap<String, CloseTransaction>,
    optimistic_closed_tabs: HashSet<String>,
    pending_role_zoom_writes: HashMap<(String, String), u64>,
    pending_window_placement_writes: HashMap<String, u64>,
    pending_window_resizes: HashMap<String, (u32, u32)>,
    pending_window_close_labels: HashSet<String>,
    overlay_capabilities: HashMap<String, String>,
    overlay_ready_webviews: HashSet<String>,
    popup_roles: HashMap<String, String>,
    provisional_launches: HashMap<String, ProvisionalLaunch>,
    recovery_required: bool,
    recovery_budgets: HashMap<String, RecoveryBudget>,
    recovery_generations: HashMap<String, u64>,
    recovering_roles: HashSet<String>,
    role_tabs: HashMap<String, String>,
    session_import_backups: HashMap<String, NativeSessionBackup>,
    surface_registry: HashMap<String, ManagedSurface>,
    retired_surface_registry: HashMap<String, ManagedSurface>,
    display_hosts: HashMap<String, RuntimeDisplayHost>,
    tabs: HashMap<String, RuntimeTab>,
}

#[derive(Clone)]
#[allow(dead_code)]
struct CloseTransaction {
    source_id: String,
    tab_type: String,
    #[cfg(target_os = "macos")]
    original_active_tab_id: Option<String>,
    #[cfg(target_os = "macos")]
    revision: u64,
    #[cfg(target_os = "macos")]
    window_id: String,
}

pub(crate) struct RuntimeTabCloseIntent {
    pub(crate) source_id: String,
    pub(crate) tab_type: String,
}

impl RuntimeTabCloseIntent {
    pub(crate) fn into_core_command(self) -> CoreCommand {
        if self.tab_type == "workspace" {
            CoreCommand::BrowserWorkspaceStop {
                workspace_id: self.source_id,
            }
        } else {
            CoreCommand::BrowserRoleStop {
                role_id: self.source_id,
            }
        }
    }
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
    macos_high_refresh_rate: bool,
    overlay_document_start_script_template: String,
}

struct NativeCreationGate {
    active: Mutex<usize>,
    changed: Condvar,
    limit: usize,
}

impl NativeCreationGate {
    fn new(limit: usize) -> Self {
        Self {
            active: Mutex::new(0),
            changed: Condvar::new(),
            limit,
        }
    }

    fn acquire(&self) -> RuntimeResult<NativeCreationPermit<'_>> {
        let mut active = self.active.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                "The native surface creation gate is unavailable.",
            )
        })?;
        while *active >= self.limit {
            active = self.changed.wait(active).map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                    "The native surface creation gate is unavailable.",
                )
            })?;
        }
        *active += 1;
        Ok(NativeCreationPermit { gate: self })
    }
}

struct NativeCreationPermit<'a> {
    gate: &'a NativeCreationGate,
}

impl Drop for NativeCreationPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.gate.active.lock() {
            *active = active.saturating_sub(1);
            self.gate.changed.notify_one();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceDiagnosticReadback {
    document_visibility_state: String,
    document_has_focus: bool,
    viewport_width: f64,
    viewport_height: f64,
    device_pixel_ratio: f64,
    hardware_concurrency: u32,
    frame_count: u32,
    observed_duration_ms: f64,
    average_fps: Option<f64>,
    #[serde(default)]
    frame_intervals_ms: Vec<f64>,
    p50_frame_interval_ms: Option<f64>,
    p95_frame_interval_ms: Option<f64>,
    p99_frame_interval_ms: Option<f64>,
    longest_frame_interval_ms: Option<f64>,
    long_task_count: Option<u32>,
    long_task_total_duration_ms: Option<f64>,
    longest_task_ms: Option<f64>,
    graphics: StateWebGraphicsRecord,
}

struct PerformanceDiagnosticSurface {
    high_refresh_rate_status: HighRefreshRateDiagnosticStatus,
    origin: Option<String>,
    role_id: String,
    webview: Webview,
}

struct PerformanceDiagnosticWindow {
    focused: bool,
    surfaces: Vec<PerformanceDiagnosticSurface>,
    window: Window,
    window_id: String,
}

pub struct SystemRuntimeExecutor {
    app: AppHandle,
    close_effect_sender: OnceLock<mpsc::SyncSender<ConcurrentRuntimeWork>>,
    configuration: RuntimeWebViewConfiguration,
    core: Arc<AppCore>,
    critical_activity_sequence: AtomicU64,
    effect_sender: OnceLock<Sender<SystemRuntimeWork>>,
    health: RuntimeHealth,
    language: Mutex<String>,
    resolved_theme: Mutex<String>,
    last_performance_diagnostics: Mutex<Option<BrowserPerformanceDiagnosticsRecord>>,
    launch_effect_sender: OnceLock<mpsc::SyncSender<ConcurrentRuntimeWork>>,
    last_critical_activity: Mutex<Instant>,
    local_storage_sync_lane: Mutex<()>,
    native_creation_lanes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    native_creation_slots: NativeCreationGate,
    optional_hydration_sender: OnceLock<mpsc::SyncSender<OptionalHydrationWork>>,
    presentation: Arc<PresentationRegistry>,
    prewarm_state: AtomicU8,
    restore_persist_requested: AtomicU64,
    restore_persist_running: AtomicBool,
    state: Mutex<RuntimeState>,
    user_data_dir: PathBuf,
}

struct RuntimeHealth(AtomicBool);

impl RuntimeHealth {
    fn new() -> Self {
        Self(AtomicBool::new(true))
    }

    fn is_healthy(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    fn mark_unhealthy(&self) {
        self.0.store(false, Ordering::Release);
    }

    fn require_healthy(&self) -> RuntimeResult<()> {
        if self.is_healthy() {
            Ok(())
        } else {
            Err(RuntimeError::new(
                "SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY",
                "The System WebView runtime is unhealthy. Restart Rion Studio before creating another native surface.",
            ))
        }
    }
}

enum SystemRuntimeWork {
    Effect {
        action_name: &'static str,
        effect: Box<CoreEffectRequest>,
        presentation_revision: u64,
        persist_runtime: bool,
    },
    RecoverSurface {
        allowed: bool,
        reason: String,
        role_id: String,
    },
    FinalizeSurfaceRelease {
        instance_id: String,
        isolated: bool,
        released: bool,
    },
}

struct ConcurrentRuntimeWork {
    action_name: &'static str,
    effect: CoreEffectRequest,
    persist_runtime: bool,
    presentation_revision: u64,
}

struct OptionalHydrationWork {
    tab_id: String,
}

fn is_surface_close_effect(action: &CoreEffectAction) -> bool {
    matches!(
        action,
        CoreEffectAction::EmbeddedDestroyRole { .. } | CoreEffectAction::EmbeddedDestroyTab { .. }
    )
}

fn is_independent_tab_launch_effect(action: &CoreEffectAction) -> bool {
    matches!(
        action,
        CoreEffectAction::EmbeddedCreateTab { .. }
            | CoreEffectAction::EmbeddedConfigureRoleSessions { .. }
            | CoreEffectAction::EmbeddedLoadRoles { .. }
            | CoreEffectAction::EmbeddedInstallOverlays { .. }
            | CoreEffectAction::EmbeddedFocusRole { .. }
    )
}

fn run_serial_runtime_work_loop<T>(receiver: Receiver<T>, mut execute: impl FnMut(T)) {
    while let Ok(work) = receiver.recv() {
        execute(work);
    }
}

fn native_effect_scope(effect: &CoreEffectRequest) -> String {
    fn collect(value: &Value, fields: &mut Vec<String>, seen: &mut HashSet<String>) {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    if matches!(key.as_str(), "roleId" | "tabId" | "windowId")
                        && let Some(identifier) = value.as_str()
                    {
                        let field = format!("{key}={identifier}");
                        if seen.insert(field.clone()) {
                            fields.push(field);
                        }
                    }
                    if fields.len() < 12 {
                        collect(value, fields, seen);
                    }
                }
            }
            Value::Array(values) => {
                for value in values.iter().take(12) {
                    collect(value, fields, seen);
                }
            }
            _ => {}
        }
    }

    let mut fields = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(value) = serde_json::to_value(&effect.action) {
        collect(&value, &mut fields, &mut seen);
    }
    if fields.is_empty() {
        "scope=none".to_owned()
    } else {
        fields.join(", ")
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_presentation_event(
    core: Arc<AppCore>,
    level: LogLevel,
    event: &'static str,
    message: &'static str,
    window_id: String,
    tab_id: Option<String>,
    revision: u64,
    trigger: &'static str,
    elapsed_ms: u64,
) {
    let context = json!({
        "elapsedMs": elapsed_ms,
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        "revision": revision,
        "tabId": tab_id,
        "trigger": trigger,
        "windowId": window_id,
    });
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture {
                entries: vec![LogCaptureRecord {
                    level,
                    source: LogSource::Browser,
                    event: event.to_owned(),
                    message: message.to_owned(),
                    context_raw_json: serde_json::to_string(&context).ok(),
                    error: None,
                }],
            })
            .await;
    });
}

fn presentation_surface_labels(surfaces: &[Webview]) -> HashSet<String> {
    surfaces
        .iter()
        .map(|surface| surface.label().to_owned())
        .collect()
}

fn native_presentation_changed(
    previous_tab_id: &Option<String>,
    next_tab_id: &Option<String>,
    previous_labels: &HashSet<String>,
    next_labels: &HashSet<String>,
) -> bool {
    previous_tab_id != next_tab_id || previous_labels != next_labels
}

fn apply_native_presentation_batch(
    request: &NativePresentationRequest,
    previous_tab_id: &Option<String>,
    previous_surfaces: Vec<Webview>,
) -> NativePresentationOutcome {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let coordinator = Arc::clone(&request.coordinator);
    let requested_at = request.requested_at;
    let revision = request.revision;
    let tab_id = request.tab_id.clone();
    let previous_tab_id = previous_tab_id.clone();
    let next_surfaces = request.next_surfaces.clone();
    let next_surface_identities = request.next_surface_identities.clone();
    let active_webview = request.active_webview.clone();
    let window = request.window.clone();
    let window_visibility = request.window_visibility;
    let focus = request.focus;
    let scheduling = request.window.run_on_main_thread(move || {
        let main_started_at = Instant::now();
        let main_queue_wait_ms = requested_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let still_desired = coordinator.lock().ok().is_some_and(|selection| {
            selection.revision == revision
                && selection.selected_tab_id == tab_id
                && selection.surface_identities(tab_id.as_deref()) == next_surface_identities
        });
        if !still_desired {
            let _ = sender.send(NativePresentationOutcome {
                applied: false,
                focus_applied: false,
                hidden_surface_count: 0,
                main_queue_wait_ms,
                main_thread_ms: main_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                shown_surface_count: 0,
                visibility_errors: Vec::new(),
            });
            return;
        }

        let previous_labels = presentation_surface_labels(&previous_surfaces);
        let next_labels = presentation_surface_labels(&next_surfaces);
        let presentation_changed =
            native_presentation_changed(&previous_tab_id, &tab_id, &previous_labels, &next_labels);
        let mut visibility_errors = Vec::new();
        let mut hidden_surface_count = 0;
        let mut shown_surface_count = 0;
        if presentation_changed {
            for surface in previous_surfaces {
                if next_labels.contains(surface.label()) {
                    continue;
                }
                match surface.hide() {
                    Ok(()) => hidden_surface_count += 1,
                    Err(error) => visibility_errors.push(error.to_string()),
                }
            }
            for surface in &next_surfaces {
                if previous_labels.contains(surface.label()) {
                    continue;
                }
                match surface.show() {
                    Ok(()) => shown_surface_count += 1,
                    Err(error) => visibility_errors.push(error.to_string()),
                }
            }
        }

        if let Some(visible) = window_visibility {
            if visible {
                if matches!(window.is_visible(), Ok(false))
                    && let Err(error) = window.show()
                {
                    visibility_errors.push(error.to_string());
                }
            } else if !matches!(window.is_visible(), Ok(false))
                && let Err(error) = window.hide()
            {
                visibility_errors.push(error.to_string());
            }
        }

        let mut focus_applied = false;
        if focus && presentation_changed && window_visibility != Some(false) {
            if matches!(window.is_focused(), Ok(false)) {
                let _ = window.set_focus();
            }
            if let Some(webview) = active_webview {
                focus_applied = webview.set_focus().is_ok();
            }
        }
        let _ = sender.send(NativePresentationOutcome {
            applied: true,
            focus_applied,
            hidden_surface_count,
            main_queue_wait_ms,
            main_thread_ms: main_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            shown_surface_count,
            visibility_errors,
        });
    });
    if let Err(error) = scheduling {
        return NativePresentationOutcome {
            applied: false,
            focus_applied: false,
            hidden_surface_count: 0,
            main_queue_wait_ms: request
                .requested_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            main_thread_ms: 0,
            shown_surface_count: 0,
            visibility_errors: vec![error.to_string()],
        };
    }
    receiver
        .recv()
        .unwrap_or_else(|_| NativePresentationOutcome {
            applied: false,
            focus_applied: false,
            hidden_surface_count: 0,
            main_queue_wait_ms: request
                .requested_at
                .elapsed()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            main_thread_ms: 0,
            shown_surface_count: 0,
            visibility_errors: vec![
                "The native presentation callback was disconnected.".to_owned(),
            ],
        })
}

fn capture_presentation_batch_events(
    batch: &NativePresentationBatch,
    outcome: &NativePresentationOutcome,
) {
    let request = &batch.request;
    let elapsed_ms = request
        .requested_at
        .elapsed()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let first_revision = if batch.first_revision == 0 {
        request.revision
    } else {
        batch.first_revision
    };
    let context = json!({
        "coalescedCount": batch.request_count.saturating_sub(1),
        "elapsedMs": elapsed_ms,
        "firstRevision": first_revision,
        "firstRequestAgeMs": batch.first_requested_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        "focusApplied": outcome.focus_applied,
        "hiddenSurfaceCount": outcome.hidden_surface_count,
        "mainQueueWaitMs": outcome.main_queue_wait_ms,
        "mainThreadMs": outcome.main_thread_ms,
        "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        "requestCount": batch.request_count,
        "revision": request.revision,
        "shownSurfaceCount": outcome.shown_surface_count,
        "tabId": request.tab_id,
        "trigger": request.trigger,
        "visibilityErrorCount": outcome.visibility_errors.len(),
        "windowId": request.window_id,
    });
    let completion_event = if !outcome.visibility_errors.is_empty() {
        "native.presentation-failed"
    } else if outcome.applied {
        "native.presentation-completed"
    } else {
        "tab.selection-superseded"
    };
    let completion_message = if !outcome.visibility_errors.is_empty() {
        "Native tab presentation encountered a platform visibility error."
    } else if outcome.applied {
        "Native tab presentation completed on the platform UI thread."
    } else {
        "A stale native tab presentation was discarded before platform mutation."
    };
    let mut entries = vec![
        LogCaptureRecord {
            level: LogLevel::Debug,
            source: LogSource::Browser,
            event: "tab.selection-coalesced".to_owned(),
            message: "Runtime tab selection requests were coalesced into one native batch."
                .to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: None,
        },
        LogCaptureRecord {
            level: if outcome.visibility_errors.is_empty() {
                LogLevel::Debug
            } else {
                LogLevel::Warn
            },
            source: LogSource::Browser,
            event: completion_event.to_owned(),
            message: completion_message.to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: None,
        },
    ];
    if outcome.main_queue_wait_ms > 100 || outcome.main_thread_ms > 100 {
        entries.push(LogCaptureRecord {
            level: LogLevel::Warn,
            source: LogSource::Browser,
            event: "native.event-loop-heartbeat-delayed".to_owned(),
            message: "The platform UI-thread presentation exceeded its latency budget.".to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: None,
        });
    }
    let core = Arc::clone(&request.core);
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture { entries })
            .await;
    });
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
            RUNTIME_AUDIO_OBSERVER_SCRIPT.to_owned(),
            runtime_indicator_script,
            native_font_document_start_script(),
        ]
        .into_iter()
        .filter(|source| !source.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        let overlay_document_start_script_template =
            macro_overlay_document_start_script_template()?;
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
                        .find(|tab| &tab.id == active_tab_id && !tab.hidden)
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
            close_effect_sender: OnceLock::new(),
            configuration: RuntimeWebViewConfiguration {
                additional_browser_arguments,
                document_start_script,
                macos_high_refresh_rate: settings.performance.macos_high_refresh_rate,
                overlay_document_start_script_template,
            },
            core,
            critical_activity_sequence: AtomicU64::new(0),
            effect_sender: OnceLock::new(),
            health: RuntimeHealth::new(),
            language: Mutex::new("en".to_owned()),
            resolved_theme: Mutex::new("light".to_owned()),
            last_performance_diagnostics: Mutex::new(None),
            launch_effect_sender: OnceLock::new(),
            last_critical_activity: Mutex::new(Instant::now()),
            local_storage_sync_lane: Mutex::new(()),
            native_creation_lanes: Mutex::new(HashMap::new()),
            native_creation_slots: NativeCreationGate::new(2),
            optional_hydration_sender: OnceLock::new(),
            presentation: Arc::new(PresentationRegistry::default()),
            prewarm_state: AtomicU8::new(0),
            restore_persist_requested: AtomicU64::new(0),
            restore_persist_running: AtomicBool::new(false),
            state: Mutex::new(RuntimeState {
                dormant_windows,
                recovery_required,
                ..RuntimeState::default()
            }),
            user_data_dir,
        })
    }

    pub fn start_effect_executor(self: &Arc<Self>) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        self.effect_sender
            .set(sender)
            .map_err(|_| "The System WebView effect executor was already started.".to_owned())?;
        let runtime = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("rion-tauri-core-effects".to_owned())
            .spawn(move || {
                run_serial_runtime_work_loop(receiver, |work| {
                    if let Some(runtime) = runtime.upgrade() {
                        runtime.execute_serial_work(work);
                    }
                });
            })
            .map_err(|error| error.to_string())?;

        // Close/isolation has a dedicated lane. A slow launch or page-load waiter must never
        // consume the workers that take game content offline.
        let (close_sender, close_receiver) = mpsc::sync_channel(32);
        self.close_effect_sender
            .set(close_sender)
            .map_err(|_| "The close System WebView executor was already started.".to_owned())?;
        let close_receiver = Arc::new(Mutex::new(close_receiver));
        for index in 0..2 {
            let runtime = Arc::downgrade(self);
            let receiver = Arc::clone(&close_receiver);
            std::thread::Builder::new()
                .name(format!("rion-native-close-{index}"))
                .spawn(move || {
                    loop {
                        let work = {
                            let Ok(receiver) = receiver.lock() else {
                                return;
                            };
                            receiver.recv()
                        };
                        let Ok(work) = work else {
                            return;
                        };
                        let Some(runtime) = runtime.upgrade() else {
                            return;
                        };
                        runtime.execute_effect_work(
                            work.action_name,
                            work.effect,
                            work.presentation_revision,
                            work.persist_runtime,
                        );
                    }
                })
                .map_err(|error| error.to_string())?;
        }

        // Launch work is bounded separately. Navigation completion is handed to Tokio and no
        // longer occupies one of these workers for the 40 second page-load timeout.
        let (launch_sender, launch_receiver) = mpsc::sync_channel(64);
        self.launch_effect_sender
            .set(launch_sender)
            .map_err(|_| "The launch System WebView executor was already started.".to_owned())?;
        let launch_receiver = Arc::new(Mutex::new(launch_receiver));
        for index in 0..4 {
            let runtime = Arc::downgrade(self);
            let receiver = Arc::clone(&launch_receiver);
            std::thread::Builder::new()
                .name(format!("rion-native-launch-{index}"))
                .spawn(move || {
                    loop {
                        let work = {
                            let Ok(receiver) = receiver.lock() else {
                                return;
                            };
                            receiver.recv()
                        };
                        let Ok(work) = work else {
                            return;
                        };
                        let Some(runtime) = runtime.upgrade() else {
                            return;
                        };
                        runtime.execute_effect_work(
                            work.action_name,
                            work.effect,
                            work.presentation_revision,
                            work.persist_runtime,
                        );
                    }
                })
                .map_err(|error| error.to_string())?;
        }

        let (optional_sender, optional_receiver) = mpsc::sync_channel(32);
        self.optional_hydration_sender
            .set(optional_sender)
            .map_err(|_| "The optional hydration executor was already started.".to_owned())?;
        let optional_receiver = Arc::new(Mutex::new(optional_receiver));
        for index in 0..2 {
            let runtime = Arc::downgrade(self);
            let receiver = Arc::clone(&optional_receiver);
            std::thread::Builder::new()
                .name(format!("rion-native-idle-{index}"))
                .spawn(move || {
                    loop {
                        let work = {
                            let Ok(receiver) = receiver.lock() else {
                                return;
                            };
                            receiver.recv()
                        };
                        let Ok(work) = work else {
                            return;
                        };
                        let Some(runtime) = runtime.upgrade() else {
                            return;
                        };
                        runtime.wait_for_optional_idle();
                        runtime.hydrate_tab_optional(&work.tab_id);
                    }
                })
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn enqueue_effect(
        self: &Arc<Self>,
        effect: CoreEffectRequest,
        action_name: &'static str,
        persist_runtime: bool,
    ) -> Result<(), String> {
        let presentation_revision = self.presentation.current_revision();
        if is_surface_close_effect(&effect.action)
            || is_independent_tab_launch_effect(&effect.action)
        {
            self.mark_critical_activity();
            let effect_id = effect.effect_id.clone();
            let operation_id = effect.operation_id.clone();
            let sender = if is_surface_close_effect(&effect.action) {
                self.close_effect_sender.get()
            } else {
                self.launch_effect_sender.get()
            };
            let enqueue = sender
                .ok_or_else(|| "The concurrent System WebView executor is unavailable.".to_owned())
                .and_then(|sender| {
                    sender
                        .try_send(ConcurrentRuntimeWork {
                            action_name,
                            effect,
                            persist_runtime,
                            presentation_revision,
                        })
                        .map_err(|error| {
                            format!(
                                "The concurrent native effect queue is full or stopped: {error}"
                            )
                        })
                });
            return enqueue.or_else(|error| {
                    self.core
                        .dispatch_core_effect_results(vec![CoreEffectResult {
                            effect_id,
                            operation_id,
                            ok: false,
                            value_json: None,
                            error: Some(rion_core::CoreErrorPayload {
                                code: "SYSTEM_SURFACE_CLOSE_WORKER_FAILED".to_owned(),
                                message: format!(
                                    "The native surface close or launch worker could not accept work: {error}"
                                ),
                            }),
                        }])
                        .map(|_| ())
                        .map_err(|dispatch_error| dispatch_error.to_string())
                });
        }
        self.effect_sender
            .get()
            .ok_or_else(|| "The System WebView effect executor is unavailable.".to_owned())?
            .send(SystemRuntimeWork::Effect {
                action_name,
                effect: Box::new(effect),
                presentation_revision,
                persist_runtime,
            })
            .map_err(|_| "The System WebView effect executor stopped unexpectedly.".to_owned())
    }

    fn mark_critical_activity(&self) {
        self.critical_activity_sequence
            .fetch_add(1, Ordering::AcqRel);
        if let Ok(mut last_activity) = self.last_critical_activity.lock() {
            *last_activity = Instant::now();
        }
    }

    fn set_launch_phase(&self, tab_id: &str, phase: LaunchPhase) {
        let (window_id, changed) = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| {
                let window_id = state.tabs.get(tab_id)?.window_id.clone();
                let changed = state.launch_phases.insert(tab_id.to_owned(), phase) != Some(phase);
                Some((window_id, changed))
            })
            .unwrap_or((String::new(), false));
        if !window_id.is_empty()
            && let Some(presentation) = self.presentation.existing(&window_id)
            && let Ok(mut presentation) = presentation.lock()
        {
            presentation.update_phase(
                tab_id,
                match phase {
                    LaunchPhase::Attaching => TabPresentationPhase::Attaching,
                    LaunchPhase::Navigating => TabPresentationPhase::Loading,
                    LaunchPhase::EssentialReady
                    | LaunchPhase::OptionalHydrating
                    | LaunchPhase::Ready => TabPresentationPhase::Ready,
                    LaunchPhase::Degraded => TabPresentationPhase::Degraded,
                },
            );
        }
        if changed {
            self.record_runtime_stage(
                format!("launch-phase:{tab_id}:{}", phase.as_str()),
                "completed",
                Instant::now(),
            );
        }
    }

    #[cfg(target_os = "macos")]
    pub fn schedule_webview_prewarm(self: &Arc<Self>) {
        // A standalone hidden Tauri WebviewWindow creates and tears down another
        // TaoWindow but cannot donate its controller to a role launch. Avoid adding
        // that unrelated native event lifecycle on macOS; launch remains fully lazy
        // until prewarming can be implemented as a windowless WKWebView actor.
        self.prewarm_state.store(3, Ordering::Release);
        self.record_runtime_stage("runtime-prewarm", "skipped", Instant::now());
    }

    #[cfg(not(target_os = "macos"))]
    pub fn schedule_webview_prewarm(self: &Arc<Self>) {
        if self
            .prewarm_state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let runtime = Arc::downgrade(self);
        let activity_sequence = self.critical_activity_sequence.load(Ordering::Acquire);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let Some(runtime) = runtime.upgrade() else {
                return;
            };
            if runtime.critical_activity_sequence.load(Ordering::Acquire) != activity_sequence {
                runtime.prewarm_state.store(3, Ordering::Release);
                return;
            }
            let worker_runtime = Arc::clone(&runtime);
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                worker_runtime.prewarm_webview_once(activity_sequence)
            })
            .await
            .unwrap_or_else(|error| Err(format!("WebView prewarm worker failed: {error}")));
            runtime.prewarm_state.store(2, Ordering::Release);
            runtime.record_runtime_stage(
                "runtime-prewarm",
                if outcome.is_ok() {
                    "completed"
                } else {
                    "degraded"
                },
                Instant::now(),
            );
        });
    }

    #[cfg(not(target_os = "macos"))]
    fn prewarm_webview_once(&self, activity_sequence: u64) -> Result<(), String> {
        if self.critical_activity_sequence.load(Ordering::Acquire) != activity_sequence {
            return Ok(());
        }
        let prewarm_dir = self.user_data_dir.join("runtime-prewarm");
        fs::create_dir_all(&prewarm_dir).map_err(|error| error.to_string())?;
        let blank: Url = "about:blank"
            .parse()
            .map_err(|error| format!("Invalid prewarm URL: {error}"))?;
        let label = format!("rion-runtime-prewarm-{}", uuid::Uuid::new_v4());
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let builder = WebviewWindowBuilder::new(&self.app, label, WebviewUrl::External(blank))
            .visible(false)
            .inner_size(1.0, 1.0)
            .data_directory(prewarm_dir)
            .data_store_identifier(
                *uuid::Uuid::parse_str("21bcf8cb-1ff0-4bd0-b56e-861fbdef3b70")
                    .expect("the prewarm data-store UUID is valid")
                    .as_bytes(),
            )
            .on_page_load(move |_webview, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = ready_sender.try_send(());
                }
            });
        let window = builder.build().map_err(|error| error.to_string())?;
        let _ = ready_receiver.recv_timeout(Duration::from_secs(2));
        window.close().map_err(|error| error.to_string())
    }

    fn wait_for_optional_idle(&self) {
        loop {
            let launch_busy = self.state.lock().ok().is_some_and(|state| {
                state
                    .launch_phases
                    .values()
                    .any(|phase| phase.blocks_optional_idle())
            });
            if launch_busy {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            let remaining = self
                .last_critical_activity
                .lock()
                .ok()
                .map(|last_activity| {
                    OPTIONAL_HYDRATION_IDLE_INTERVAL.saturating_sub(last_activity.elapsed())
                })
                .unwrap_or_default();
            if remaining.is_zero() {
                return;
            }
            std::thread::sleep(remaining.min(Duration::from_millis(50)));
        }
    }

    pub(crate) fn wait_for_shell_idle(&self) {
        self.wait_for_optional_idle();
    }

    fn schedule_optional_hydration(&self, tab_id: &str) {
        if let Some(sender) = self.optional_hydration_sender.get() {
            let _ = sender.try_send(OptionalHydrationWork {
                tab_id: tab_id.to_owned(),
            });
        }
    }

    fn hydrate_tab_optional(&self, tab_id: &str) {
        self.set_launch_phase(tab_id, LaunchPhase::OptionalHydrating);
        let mut degraded = false;
        let surfaces = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state.tabs.get(tab_id).map(|tab| {
                    tab.roles
                        .iter()
                        .map(|(role_id, surface)| {
                            (role_id.clone(), surface.generation, surface.webview.clone())
                        })
                        .collect::<Vec<_>>()
                })
            })
            .unwrap_or_default();
        for (role_id, generation, webview) in surfaces {
            self.wait_for_optional_idle();
            let current = self.state.lock().ok().is_some_and(|state| {
                !state.close_coordinator.closing_tabs.contains(tab_id)
                    && !state.close_coordinator.closing_roles.contains(&role_id)
                    && state.role_tabs.get(&role_id).is_some_and(|current_tab_id| {
                        current_tab_id == tab_id
                            && state.tabs.get(tab_id).is_some_and(|tab| {
                                tab.roles.get(&role_id).is_some_and(|surface| {
                                    surface.generation == generation
                                        && surface.webview.label() == webview.label()
                                })
                            })
                    })
            });
            if !current {
                continue;
            }
            let shortcut_status = install_role_zoom_shortcut_handler(&webview, self.app.clone());
            degraded |= shortcut_status.is_err();
            self.wait_for_optional_idle();
            let high_refresh_rate_status = configure_platform_high_refresh_rate(
                &webview,
                self.configuration.macos_high_refresh_rate,
            );
            if let Ok(mut state) = self.state.lock()
                && let Some(surface) = state
                    .tabs
                    .get_mut(tab_id)
                    .and_then(|tab| tab.roles.get_mut(&role_id))
                && surface.generation == generation
                && surface.webview.label() == webview.label()
            {
                surface.high_refresh_rate_status = high_refresh_rate_status;
            }
            self.record_runtime_stage(
                format!("optional-hydration:{tab_id}:{role_id}"),
                if shortcut_status.is_ok() {
                    "completed"
                } else {
                    "degraded"
                },
                Instant::now(),
            );
        }
        self.wait_for_optional_idle();
        if let Err(error) = self.hydrate_tab_dividers(tab_id) {
            degraded = true;
            self.record_runtime_stage(
                format!("optional-dividers:{tab_id}:{}", error.code),
                "degraded",
                Instant::now(),
            );
        }
        self.set_launch_phase(
            tab_id,
            if degraded {
                LaunchPhase::Degraded
            } else {
                LaunchPhase::Ready
            },
        );
    }

    fn hydrate_tab_dividers(&self, tab_id: &str) -> RuntimeResult<()> {
        let (window_id, window, gap, role_inputs) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                    "The runtime tab closed before optional dividers were attached.",
                )
            })?;
            if !tab.dividers.is_empty() || tab.roles.len() < 2 {
                return Ok(());
            }
            if state.close_coordinator.closing_tabs.contains(tab_id) {
                return Ok(());
            }
            let host = state.display_hosts.get(&tab.window_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                    "The runtime display host closed before optional dividers were attached.",
                )
            })?;
            (
                tab.window_id.clone(),
                host.window.clone(),
                tab.workspace_appearance.gap,
                tab.roles
                    .iter()
                    .map(|(role_id, surface)| LayoutRoleInput {
                        role_id: role_id.clone(),
                        rect: LayoutRect {
                            x: surface.rect.x,
                            y: surface.rect.y,
                            width: surface.rect.width,
                            height: surface.rect.height,
                        },
                    })
                    .collect::<Vec<_>>(),
            )
        };
        let content_metrics = runtime_window_content_metrics(&window)?;
        let (_, descriptors) = self.resolve_runtime_layout(content_metrics, role_inputs, gap)?;
        let mut created = Vec::with_capacity(descriptors.len());
        for (index, descriptor, bounds) in descriptors {
            self.wait_for_optional_idle();
            let still_current = self.state.lock().ok().is_some_and(|state| {
                state
                    .tabs
                    .get(tab_id)
                    .is_some_and(|tab| tab.window_id == window_id && tab.dividers.is_empty())
                    && !state.close_coordinator.closing_tabs.contains(tab_id)
            });
            if !still_current {
                break;
            }
            let bounds = divider_hit_bounds(&descriptor.axis, bounds);
            let lifecycle_id = format!("{tab_id}:divider:{index}");
            let webview = self.with_native_creation_lane(&window_id, || {
                self.add_child_bounded(
                    &window,
                    WebviewBuilder::new(
                        runtime_label("game-divider", &format!("{tab_id}:{index}")),
                        WebviewUrl::App(
                            format!("runtime-divider.html?axis={}", descriptor.axis).into(),
                        ),
                    )
                    .transparent(true),
                    LogicalPosition::new(bounds.x, bounds.y),
                    LogicalSize::new(bounds.width, bounds.height),
                    &lifecycle_id,
                )
            })?;
            let lifecycle = self.install_surface_lifecycle_tracker(&webview)?;
            let surface_instance_id = self.register_managed_surface(
                &webview,
                &lifecycle,
                ManagedSurfaceKind::Divider,
                ManagedSurfacePhase::Live,
                None,
                Some(tab_id),
                &window_id,
                0,
            )?;
            let selected = self
                .presentation
                .existing(&window_id)
                .and_then(|presentation| {
                    presentation.lock().ok().map(|mut presentation| {
                        let bound = presentation.bind_surface(
                            tab_id,
                            SurfacePresentationBinding {
                                generation: 0,
                                instance_id: surface_instance_id.clone(),
                                webview: webview.clone(),
                            },
                        );
                        (
                            bound,
                            presentation.selected_tab_id.as_deref() == Some(tab_id),
                        )
                    })
                })
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The runtime tab presentation disappeared before its divider could bind.",
                    )
                })?;
            if !selected.0 {
                let _ = self.close_managed_surface_and_wait(
                    &surface_instance_id,
                    &format!("{tab_id}:divider:{index}"),
                );
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                    "The runtime tab was removed before its divider could bind.",
                ));
            }
            if !selected.1 {
                let _ = webview.hide();
            }
            created.push(RuntimeDivider {
                descriptor,
                index,
                surface_instance_id,
                webview,
            });
        }
        let inserted = if let Ok(mut state) = self.state.lock()
            && let Some(tab) = state.tabs.get_mut(tab_id)
            && tab.window_id == window_id
            && tab.dividers.is_empty()
        {
            tab.dividers = std::mem::take(&mut created);
            true
        } else {
            false
        };
        if !inserted {
            for divider in created {
                let _ = self.close_managed_surface_and_wait(
                    &divider.surface_instance_id,
                    &format!("{tab_id}:divider:{}", divider.index),
                );
            }
        } else if self
            .presentation
            .existing(&window_id)
            .is_some_and(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .is_some_and(|selection| selection.selected_tab_id.as_deref() == Some(tab_id))
            })
        {
            let _ = self.request_tab_presentation(tab_id, false, "optional-dividers-attached");
        }
        Ok(())
    }

    fn execute_serial_work(self: &Arc<Self>, work: SystemRuntimeWork) {
        match work {
            SystemRuntimeWork::Effect {
                action_name,
                effect,
                presentation_revision,
                persist_runtime,
            } => self.execute_effect_work(
                action_name,
                *effect,
                presentation_revision,
                persist_runtime,
            ),
            SystemRuntimeWork::RecoverSurface {
                allowed,
                reason,
                role_id,
            } => {
                if self.health.is_healthy() {
                    self.recover_system_surface(role_id, reason, allowed);
                } else {
                    if let Ok(mut state) = self.state.lock() {
                        state.recovering_roles.remove(&role_id);
                    }
                    let _ = self.app.emit(
                        "rion://shell-error",
                        json!({
                            "code": "SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY",
                            "message": "The System WebView runtime rejected recovery after a stalled native lifecycle. Restart Rion Studio to recover safely.",
                            "roleId": role_id,
                            "reason": reason
                        }),
                    );
                }
            }
            SystemRuntimeWork::FinalizeSurfaceRelease {
                instance_id,
                isolated,
                released,
            } => self.finalize_surface_release(&instance_id, isolated, released),
        }
    }

    fn execute_effect_work(
        self: &Arc<Self>,
        action_name: &'static str,
        effect: CoreEffectRequest,
        presentation_revision: u64,
        persist_runtime: bool,
    ) {
        if matches!(effect.action, CoreEffectAction::EmbeddedLoadRoles { .. }) {
            self.execute_role_load_effect_async(
                action_name,
                effect,
                presentation_revision,
                persist_runtime,
            );
            return;
        }
        let effect_id = effect.effect_id.clone();
        let close_effect = is_surface_close_effect(&effect.action);
        let started = Instant::now();
        let scope = native_effect_scope(&effect);
        eprintln!("System WebView effect: {action_name} started (effect={effect_id}, {scope}).");
        let result = if self.health.is_healthy() || is_surface_close_effect(&effect.action) {
            // Close remains available for quarantined surfaces even if another native
            // lifecycle operation marked the general runtime unhealthy.
            self.execute(effect, presentation_revision)
        } else {
            CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: effect.operation_id,
                ok: false,
                value_json: None,
                error: Some(rion_core::CoreErrorPayload {
                    code: "SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY".to_owned(),
                    message: "The System WebView runtime stopped accepting native lifecycle operations after a stalled callback. Restart Rion Studio to recover safely.".to_owned(),
                }),
            }
        };
        if close_effect {
            let succeeded = result.ok;
            let error_code = result.error.as_ref().map(|error| error.code.clone());
            eprintln!(
                "System WebView effect: {action_name} completed (effect={effect_id}, {scope}, ok={succeeded}, elapsedMs={}).",
                started.elapsed().as_millis()
            );
            // Acknowledge native isolation before any Core/SQLite callback. The
            // close worker is immediately reusable for the next tab in a burst;
            // restore-session durability is coalesced on one background worker.
            match self.core.dispatch_core_effect_results(vec![result]) {
                Ok(report) => {
                    let accepted = report.accepted.iter().any(|id| id == &effect_id);
                    self.record_close_effect_completion(
                        action_name,
                        &effect_id,
                        succeeded,
                        accepted,
                        error_code.as_deref(),
                        started.elapsed(),
                    );
                    if succeeded && accepted {
                        if persist_runtime {
                            self.schedule_restore_session_persist();
                        } else {
                            self.publish_projection();
                        }
                    }
                }
                Err(error) => {
                    self.record_close_effect_completion(
                        action_name,
                        &effect_id,
                        succeeded,
                        false,
                        Some(error.code()),
                        started.elapsed(),
                    );
                }
            }
            return;
        }
        let persistence_error = (result.ok && persist_runtime)
            .then(|| self.persist_restore_session(false).err())
            .flatten();
        let result = finalize_persisted_effect_result(result, persist_runtime, persistence_error);
        let succeeded = result.ok;
        eprintln!(
            "System WebView effect: {action_name} completed (effect={effect_id}, {scope}, ok={succeeded}, elapsedMs={}).",
            started.elapsed().as_millis()
        );
        if self.core.dispatch_core_effect_results(vec![result]).is_ok()
            && succeeded
            && persist_runtime
        {
            self.publish_projection();
        }
    }

    fn schedule_restore_session_persist(self: &Arc<Self>) {
        self.restore_persist_requested
            .fetch_add(1, Ordering::AcqRel);
        if self
            .restore_persist_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || {
            let mut failure_count = 0usize;
            loop {
                // Collapse a rapid close burst into one durable snapshot.
                let delay = match failure_count {
                    0 => Duration::from_millis(50),
                    1 => Duration::from_secs(1),
                    2 => Duration::from_secs(5),
                    _ => Duration::from_secs(30),
                };
                std::thread::sleep(delay);
                let target = runtime.restore_persist_requested.load(Ordering::Acquire);
                match runtime.persist_restore_session(false) {
                    Ok(()) => {
                        failure_count = 0;
                        runtime.publish_projection();
                    }
                    Err(error) => {
                        failure_count = failure_count.saturating_add(1);
                        eprintln!("Runtime close durability retry failed: {error}");
                        if failure_count < 4 {
                            continue;
                        }
                        let _ = runtime.app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "SYSTEM_RUNTIME_PERSIST_FAILED",
                                "failureKind": "close-durability-retry-exhausted",
                                "message": "The game pages stopped, but Rion Studio could not persist the closed tab state. Restart Rion Studio before relying on window restoration."
                            }),
                        );
                    }
                }
                if runtime.restore_persist_requested.load(Ordering::Acquire) != target {
                    continue;
                }
                runtime
                    .restore_persist_running
                    .store(false, Ordering::Release);
                if runtime.restore_persist_requested.load(Ordering::Acquire) == target
                    || runtime
                        .restore_persist_running
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_err()
                {
                    break;
                }
            }
        });
    }

    fn record_close_effect_completion(
        &self,
        action_name: &'static str,
        effect_id: &str,
        native_succeeded: bool,
        acknowledgement_accepted: bool,
        error_code: Option<&str>,
        elapsed: Duration,
    ) {
        let core = Arc::clone(&self.core);
        let context = json!({
            "acknowledgementAccepted": acknowledgement_accepted,
            "action": action_name,
            "effectId": effect_id,
            "elapsedMs": elapsed.as_millis().min(u64::MAX as u128) as u64,
            "errorCode": error_code,
            "nativeSucceeded": native_succeeded,
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: if native_succeeded && acknowledgement_accepted {
                            LogLevel::Debug
                        } else {
                            LogLevel::Error
                        },
                        source: LogSource::Browser,
                        event: "surface.close-effect-completed".to_owned(),
                        message: "Native close completion was dispatched to the Core coordinator."
                            .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    fn execute_role_load_effect_async(
        self: &Arc<Self>,
        action_name: &'static str,
        effect: CoreEffectRequest,
        _presentation_revision: u64,
        persist_runtime: bool,
    ) {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        let started = Instant::now();
        let roles = match effect.action {
            CoreEffectAction::EmbeddedLoadRoles { roles } => roles,
            _ => unreachable!("role-load async dispatch only accepts EmbeddedLoadRoles"),
        };
        let pending = match self.start_role_loads(roles) {
            Ok(pending) => pending,
            Err(error) => {
                let result = CoreEffectResult {
                    effect_id,
                    operation_id,
                    ok: false,
                    value_json: None,
                    error: Some(rion_core::CoreErrorPayload {
                        code: error.code.to_owned(),
                        message: error.message,
                    }),
                };
                let _ = self.core.dispatch_core_effect_results(vec![result]);
                return;
            }
        };
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let role_ids = pending
                .iter()
                .map(|(role_id, _, _)| role_id.clone())
                .collect::<Vec<_>>();
            let mut navigation_error = None;
            for (role_id, _, navigation) in &pending {
                if let Err(message) = navigation.wait_async().await {
                    navigation_error = Some(message);
                    break;
                }
                runtime.record_runtime_stage(
                    format!("page-finished:{role_id}"),
                    "completed",
                    started,
                );
            }
            let runtime_for_completion = Arc::clone(&runtime);
            let completion = tauri::async_runtime::spawn_blocking(move || {
                let controlled_labels = pending
                    .iter()
                    .map(|(_, surface, _)| surface.label().to_owned())
                    .collect::<Vec<_>>();
                let result = if let Some(message) = navigation_error {
                    Err(RuntimeError::new("TAURI_NAVIGATION_FAILED", message))
                } else {
                    pending.iter().try_for_each(|(role_id, surface, _)| {
                        runtime_for_completion.reassert_role_keys(role_id, surface)
                    })
                };
                runtime_for_completion.finish_controlled_navigations(&controlled_labels);
                result
            })
            .await
            .unwrap_or_else(|error| {
                Err(RuntimeError::new(
                    "TAURI_NAVIGATION_FAILED",
                    format!("Navigation completion task failed: {error}"),
                ))
            });
            let mut result = match completion {
                Ok(()) => CoreEffectResult {
                    effect_id,
                    operation_id,
                    ok: true,
                    value_json: None,
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
            };
            if result.ok {
                let tab_ids = runtime
                    .state
                    .lock()
                    .ok()
                    .map(|state| {
                        role_ids
                            .iter()
                            .filter_map(|role_id| state.role_tabs.get(role_id).cloned())
                            .collect::<HashSet<_>>()
                    })
                    .unwrap_or_default();
                for tab_id in tab_ids {
                    runtime.set_launch_phase(&tab_id, LaunchPhase::EssentialReady);
                    runtime.schedule_optional_hydration(&tab_id);
                }
            }
            let persistence_error = (result.ok && persist_runtime)
                .then(|| runtime.persist_restore_session(false).err())
                .flatten();
            result = finalize_persisted_effect_result(result, persist_runtime, persistence_error);
            let succeeded = result.ok;
            eprintln!(
                "System WebView effect: {action_name} completed asynchronously (ok={succeeded}, elapsedMs={}).",
                started.elapsed().as_millis()
            );
            if runtime
                .core
                .dispatch_core_effect_results(vec![result])
                .is_ok()
                && succeeded
                && persist_runtime
            {
                runtime.publish_projection();
            }
        });
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
                downloads: EngineCapabilityStatus::Disabled,
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

    pub(crate) fn mark_unhealthy_after_failed_compensation(&self) {
        self.health.mark_unhealthy();
    }

    pub(crate) fn launch_target_for_window_id(
        &self,
        window_id: &str,
    ) -> Result<EmbeddedLaunchTargetRecord, String> {
        self.state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .display_hosts
            .get(window_id)
            .map(|host| host.target.clone())
            .ok_or_else(|| "The conflicting runtime window has no live native host.".to_owned())
    }

    pub(crate) fn role_zoom_factor_for_tab(
        &self,
        tab_id: &str,
        role_id: &str,
    ) -> Result<f64, String> {
        self.state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .tabs
            .get(tab_id)
            .and_then(|tab| tab.roles.get(role_id))
            .map(|surface| surface.zoom_factor)
            .ok_or_else(|| "The conflicting role has no live native surface.".to_owned())
    }

    fn record_runtime_stage(&self, stage: impl Into<String>, status: &str, started: Instant) {
        let stage = stage.into();
        let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        eprintln!(
            "System WebView lifecycle: stage={stage} status={status} elapsedMs={}",
            elapsed_ms
        );
        let core = Arc::clone(&self.core);
        let context = json!({
            "elapsedMs": elapsed_ms,
            "phase": stage,
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
            "status": status,
        });
        let level = if status == "failed" {
            LogLevel::Warn
        } else {
            LogLevel::Debug
        };
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level,
                        source: LogSource::Browser,
                        event: "tab.launch-phase".to_owned(),
                        message: "Runtime tab launch phase changed.".to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    fn install_surface_lifecycle_tracker(
        &self,
        webview: &Webview,
    ) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
        platform_surface_lifecycle_tracker(webview)
    }

    fn setup_role_surface(
        &self,
        webview: &Webview,
        role_id: &str,
        generation: u64,
    ) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
        platform_role_surface_setup(
            webview,
            self.app.clone(),
            SurfaceFailureTarget::Role {
                role_id: role_id.to_owned(),
                generation,
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn register_managed_surface(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        kind: ManagedSurfaceKind,
        phase: ManagedSurfacePhase,
        role_id: Option<&str>,
        tab_id: Option<&str>,
        window_id: &str,
        generation: u64,
    ) -> RuntimeResult<String> {
        let instance_id = next_surface_instance_id(webview.label());
        let surface = ManagedSurface {
            close_started_at: None,
            generation,
            instance_id: instance_id.clone(),
            kind,
            lifecycle: Arc::clone(lifecycle),
            native_lifecycle_lane: Arc::new(Mutex::new(())),
            phase,
            role_id: role_id.map(str::to_owned),
            tab_id: tab_id.map(str::to_owned),
            webview: webview.clone(),
            window_id: window_id.to_owned(),
        };
        let role_fenced = {
            let mut state = self.state()?;
            let fenced = role_id.is_some_and(|role_id| {
                state.close_coordinator.closing_roles.contains(role_id)
                    || state.close_coordinator.quarantined_roles.contains(role_id)
            });
            if !fenced {
                state
                    .surface_registry
                    .insert(instance_id.clone(), surface.clone());
            }
            fenced
        };
        if role_fenced {
            if let Some(role_id) = role_id {
                let _ = self.close_surface_and_wait(webview, lifecycle, role_id);
            }
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                "The role is closing or quarantined and cannot register another native surface until Rion Studio restarts.",
            ));
        }
        self.record_surface_event(
            LogLevel::Debug,
            "surface.registered",
            "Native surface registered.",
            &surface,
        );
        if surface.tab_id.is_some() {
            self.record_surface_event(
                LogLevel::Debug,
                "tab.surface-attached",
                "Native surface attached to a runtime tab.",
                &surface,
            );
        }
        Ok(instance_id)
    }

    fn managed_surface(&self, instance_id: &str) -> RuntimeResult<ManagedSurface> {
        let state = self.state()?;
        state
            .surface_registry
            .get(instance_id)
            .or_else(|| state.retired_surface_registry.get(instance_id))
            .cloned()
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The native surface registry entry is missing.",
                )
            })
    }

    fn managed_surface_ids_for_role(&self, role_id: &str) -> RuntimeResult<Vec<String>> {
        let mut surfaces = self
            .state()?
            .surface_registry
            .values()
            .filter(|surface| {
                surface.role_id.as_deref() == Some(role_id) && surface.phase.blocks_role_relaunch()
            })
            .map(|surface| {
                let order = managed_surface_close_priority(surface.kind);
                (order, surface.instance_id.clone())
            })
            .collect::<Vec<_>>();
        surfaces.sort();
        Ok(surfaces
            .into_iter()
            .map(|(_, instance_id)| instance_id)
            .collect())
    }

    fn set_managed_surface_phase(
        &self,
        instance_id: &str,
        phase: ManagedSurfacePhase,
    ) -> RuntimeResult<()> {
        let surface = {
            let mut state = self.state()?;
            let surface = if state.surface_registry.contains_key(instance_id) {
                state.surface_registry.get_mut(instance_id)
            } else {
                state.retired_surface_registry.get_mut(instance_id)
            }
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The native surface registry entry is missing.",
                )
            })?;
            surface.phase = phase;
            if phase == ManagedSurfacePhase::CloseRequested {
                surface.close_started_at = Some(Instant::now());
            }
            surface.clone()
        };
        self.record_surface_event(
            LogLevel::Debug,
            "surface.phase",
            "Native surface phase changed.",
            &surface,
        );
        Ok(())
    }

    fn remove_managed_surface(&self, instance_id: &str) -> RuntimeResult<()> {
        let removed = {
            let mut state = self.state()?;
            if let Some(surface) = state.surface_registry.get_mut(instance_id) {
                surface.phase = ManagedSurfacePhase::Released;
            }
            if let Some(surface) = state.retired_surface_registry.get_mut(instance_id) {
                surface.phase = ManagedSurfacePhase::Released;
            }
            state
                .surface_registry
                .remove(instance_id)
                .or_else(|| state.retired_surface_registry.remove(instance_id))
        };
        if let Some(surface) = removed {
            self.presentation.unbind_surface(instance_id);
            self.record_surface_event(
                LogLevel::Debug,
                "surface.released",
                "Native surface release confirmed.",
                &surface,
            );
        }
        Ok(())
    }

    fn retire_managed_surface(&self, instance_id: &str) -> RuntimeResult<ManagedSurface> {
        let surface = {
            let mut state = self.state()?;
            if let Some(surface) = state.retired_surface_registry.get(instance_id) {
                return Ok(surface.clone());
            }
            let mut surface = state.surface_registry.remove(instance_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The native surface registry entry is missing.",
                )
            })?;
            surface.phase = ManagedSurfacePhase::Releasing;
            state
                .retired_surface_registry
                .insert(instance_id.to_owned(), surface.clone());
            surface
        };
        self.presentation.unbind_surface(instance_id);
        self.record_surface_event(
            LogLevel::Debug,
            "surface.lease-retired",
            "The isolated native surface lease moved to background cleanup.",
            &surface,
        );
        Ok(surface)
    }

    fn record_surface_event(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        surface: &ManagedSurface,
    ) {
        let core = Arc::clone(&self.core);
        let context = json!({
            "isolationMs": (event == "surface.isolated")
                .then(|| surface.close_started_at.map(|started| started.elapsed().as_millis()))
                .flatten(),
            "releaseMs": (event == "surface.released")
                .then(|| surface.close_started_at.map(|started| started.elapsed().as_millis()))
                .flatten(),
            "generation": surface.generation,
            "instanceId": surface.instance_id,
            "kind": surface.kind.as_str(),
            "phase": surface.phase.as_str(),
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "other" },
            "roleId": surface.role_id,
            "tabId": surface.tab_id,
            "webviewLabel": surface.webview.label(),
            "windowId": surface.window_id,
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level,
                        source: LogSource::Browser,
                        event: event.to_owned(),
                        message: message.to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn record_presentation_event(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        window_id: &str,
        tab_id: Option<&str>,
        revision: u64,
        trigger: &'static str,
        elapsed_ms: u64,
    ) {
        capture_presentation_event(
            Arc::clone(&self.core),
            level,
            event,
            message,
            window_id.to_owned(),
            tab_id.map(str::to_owned),
            revision,
            trigger,
            elapsed_ms,
        );
    }

    fn apply_native_active_style(
        &self,
        window_id: &str,
        tab_id: Option<&str>,
        revision: u64,
        trigger: &'static str,
    ) {
        #[cfg(target_os = "macos")]
        let result = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .display_hosts
                    .get(window_id)
                    .map(|host| host.tabs_controller.clone())
            })
            .ok_or_else(|| "The AppKit tab controller was not found.".to_owned())
            .and_then(|controller| controller.set_active(tab_id));
        #[cfg(windows)]
        let result = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .display_hosts
                    .get(window_id)
                    .map(|host| host.tab_strip.clone())
            })
            .ok_or_else(|| "The WebView2 tab strip was not found.".to_owned())
            .and_then(|tab_strip| {
                let tab_id = serde_json::to_string(&tab_id).map_err(|error| error.to_string())?;
                tab_strip
                    .eval(format!("window.__rionSetActiveRuntimeTab?.({tab_id});"))
                    .map_err(|error| error.to_string())
            });
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: Result<(), String> = Ok(());

        if result.is_err() {
            self.record_presentation_event(
                LogLevel::Warn,
                "native.active-style-failed",
                "Native active tab style could not be applied optimistically.",
                window_id,
                tab_id,
                revision,
                trigger,
                0,
            );
        }
    }

    fn remember_native_active_style(&self, window_id: &str, tab_id: Option<&str>) {
        #[cfg(target_os = "macos")]
        if let Some(controller) = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.tabs_controller.clone())
        }) {
            controller.remember_active(tab_id);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (window_id, tab_id);
    }

    fn reserve_native_tab(
        &self,
        window_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
        revision: u64,
    ) -> RuntimeResult<()> {
        let started = Instant::now();
        #[cfg(not(target_os = "macos"))]
        let _ = workspace_template;
        #[cfg(target_os = "macos")]
        let controller = {
            self.state()?
                .display_hosts
                .get(window_id)
                .map(|host| host.tabs_controller.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The AppKit tab controller was not found.",
                    )
                })?
        };
        #[cfg(target_os = "macos")]
        let result = controller
            .reserve(window_id, tab_id, name, tab_type, workspace_template)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            });
        #[cfg(windows)]
        let tab_strip = {
            self.state()?
                .display_hosts
                .get(window_id)
                .map(|host| host.tab_strip.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The WebView2 tab strip was not found.",
                    )
                })?
        };
        #[cfg(windows)]
        let result = {
            let payload = serde_json::to_string(&json!({
                "id": tab_id,
                "name": name,
                "type": tab_type,
            }))
            .map_err(|error| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", error.to_string())
            })?;
            tab_strip
                .eval(format!("window.__rionReserveRuntimeTab?.({payload});"))
                .map_err(RuntimeError::tauri)
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: RuntimeResult<()> = Ok(());
        self.record_presentation_event(
            if result.is_ok() {
                LogLevel::Debug
            } else {
                LogLevel::Warn
            },
            "tab.surface-reserved",
            if result.is_ok() {
                "The provisional native tab was reserved."
            } else {
                "The provisional native tab could not be reserved."
            },
            window_id,
            Some(tab_id),
            revision,
            "launch",
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        );
        result
    }

    fn remove_native_tab_reservation(
        &self,
        window_id: &str,
        tab_id: &str,
        active_tab_id: Option<&str>,
    ) {
        #[cfg(target_os = "macos")]
        let target = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.tabs_controller.clone())
        });
        #[cfg(target_os = "macos")]
        if let Some(controller) = target {
            let _ = controller.remove(tab_id, active_tab_id);
        }
        #[cfg(windows)]
        let target = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.tab_strip.clone())
        });
        #[cfg(windows)]
        if let Some(tab_strip) = target {
            let tab_id = serde_json::to_string(tab_id).unwrap_or_else(|_| "null".to_owned());
            let active_tab_id =
                serde_json::to_string(&active_tab_id).unwrap_or_else(|_| "null".to_owned());
            let _ = tab_strip.eval(format!(
                "window.__rionRemoveRuntimeTab?.({tab_id}, {active_tab_id});"
            ));
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn replace_native_tab_reservation(
        &self,
        window_id: &str,
        provisional_id: &str,
        tab_id: &str,
        name: &str,
        tab_type: &str,
        workspace_template: Option<&str>,
        active_tab_id: Option<&str>,
        revision: u64,
    ) -> RuntimeResult<()> {
        #[cfg(not(target_os = "macos"))]
        let _ = workspace_template;
        #[cfg(target_os = "macos")]
        let result = self
            .state()?
            .display_hosts
            .get(window_id)
            .map(|host| host.tabs_controller.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The AppKit tab controller was not found.",
                )
            })?
            .replace_reservation(
                provisional_id,
                tab_id,
                name,
                tab_type,
                workspace_template,
                active_tab_id,
            )
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            });
        #[cfg(windows)]
        let result = {
            let tab_strip = self
                .state()?
                .display_hosts
                .get(window_id)
                .map(|host| host.tab_strip.clone())
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The WebView2 tab strip was not found.",
                    )
                })?;
            let provisional_id = serde_json::to_string(provisional_id)
                .map_err(|error| RuntimeError::tauri(error.to_string()))?;
            let active_tab_id = serde_json::to_string(&active_tab_id)
                .map_err(|error| RuntimeError::tauri(error.to_string()))?;
            let payload = serde_json::to_string(&json!({
                "id": tab_id,
                "name": name,
                "type": tab_type,
            }))
            .map_err(|error| RuntimeError::tauri(error.to_string()))?;
            tab_strip
                .eval(format!(
                    "window.__rionRemoveRuntimeTab?.({provisional_id}, null); window.__rionReserveRuntimeTab?.({payload}); window.__rionSetActiveRuntimeTab?.({active_tab_id});"
                ))
                .map_err(RuntimeError::tauri)
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let result: RuntimeResult<()> = Ok(());
        self.record_presentation_event(
            if result.is_ok() {
                LogLevel::Debug
            } else {
                LogLevel::Warn
            },
            "tab.surface-reservation-reconciled",
            if result.is_ok() {
                "The provisional native tab was reconciled in one native transaction."
            } else {
                "The provisional native tab could not be reconciled."
            },
            window_id,
            Some(tab_id),
            revision,
            "launch",
            0,
        );
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch_native_presentation(
        &self,
        window_id: String,
        tab_id: Option<String>,
        revision: u64,
        trigger: &'static str,
        requested_at: Instant,
        window: Window,
        previous_tab_id: Option<String>,
        previous_surfaces: Vec<Webview>,
        next_surfaces: Vec<Webview>,
        active_webview: Option<Webview>,
        window_visibility: Option<bool>,
        focus: bool,
    ) {
        let Ok(presentation) = self.presentation.coordinator(&window_id) else {
            self.record_presentation_event(
                LogLevel::Warn,
                "native.presentation-completed",
                "Native tab presentation could not resolve its window coordinator.",
                &window_id,
                tab_id.as_deref(),
                revision,
                trigger,
                0,
            );
            return;
        };
        let next_surface_identities = presentation
            .lock()
            .ok()
            .map(|state| state.surface_identities(tab_id.as_deref()))
            .unwrap_or_default();
        let actor = match self.presentation.actor(&window_id) {
            Ok(actor) => actor,
            Err(message) => {
                self.record_presentation_event(
                    LogLevel::Warn,
                    "native.presentation-completed",
                    "Native tab presentation could not start its window actor.",
                    &window_id,
                    tab_id.as_deref(),
                    revision,
                    trigger,
                    requested_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                );
                eprintln!("Native window actor unavailable: {message}");
                return;
            }
        };
        let dispatch_result = actor.dispatch(NativePresentationRequest {
            active_webview,
            coordinator: presentation,
            core: Arc::clone(&self.core),
            focus,
            next_surface_identities,
            next_surfaces,
            observed_previous_tab_id: previous_tab_id,
            observed_previous_surfaces: previous_surfaces,
            requested_at,
            revision,
            tab_id,
            trigger,
            window,
            window_id,
            window_visibility,
        });
        if let Err(message) = dispatch_result {
            eprintln!("Native window actor enqueue failed: {message}");
        }
    }

    fn wait_for_presentation_paint_barrier(&self, window_id: &str, revision: u64) {
        let started = Instant::now();
        let applied = self
            .presentation
            .actor(window_id)
            .ok()
            .is_some_and(|actor| {
                actor.wait_until_applied(revision, PRESENTATION_PAINT_BARRIER_TIMEOUT)
            });
        // Queue one additional no-op after the P0 AppKit/UI-dispatcher mutation.
        // Controller creation may proceed after this turn even if platform paint
        // instrumentation is unavailable; launch can never wait indefinitely.
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let scheduled = self
            .app
            .run_on_main_thread(move || {
                let _ = sender.send(());
            })
            .is_ok();
        let yielded = scheduled
            && receiver
                .recv_timeout(PRESENTATION_PAINT_BARRIER_TIMEOUT)
                .is_ok();
        self.record_presentation_event(
            LogLevel::Debug,
            "native.presentation-paint-barrier",
            "Native presentation yielded a UI turn before controller creation.",
            window_id,
            None,
            revision,
            "launch",
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        );
        if !applied || !yielded {
            eprintln!(
                "Native presentation paint barrier used bounded fail-open (window={window_id}, revision={revision}, applied={applied}, yielded={yielded})."
            );
        }
    }

    fn record_tab_close_presentation(
        &self,
        tab_id: &str,
        next_tab_id: Option<&str>,
        revision: u64,
        elapsed: Duration,
    ) {
        let core = Arc::clone(&self.core);
        let context = json!({
            "nextTabId": next_tab_id,
            "nextTabVisibleMs": elapsed.as_millis(),
            "presentationRevision": revision,
            "tabId": tab_id,
            "uiHiddenMs": elapsed.as_millis(),
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Debug,
                        source: LogSource::Browser,
                        event: "surface.presentation-closed".to_owned(),
                        message: "Runtime tab presentation closed immediately.".to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    fn record_surface_stage_by_label(
        &self,
        level: LogLevel,
        event: &'static str,
        message: &'static str,
        webview_label: &str,
    ) {
        let surface = self.state.lock().ok().and_then(|state| {
            state
                .surface_registry
                .values()
                .find(|surface| surface.webview.label() == webview_label)
                .cloned()
        });
        if let Some(surface) = surface {
            self.record_surface_event(level, event, message, &surface);
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

    pub fn set_theme(&self, theme: &str) {
        if matches!(theme, "light" | "dark") {
            if let Ok(mut current) = self.resolved_theme.lock() {
                *current = theme.to_owned();
            }
            #[cfg(windows)]
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

    pub fn window_for_id(&self, window_id: &str) -> Option<Window> {
        self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .get(window_id)
                .map(|host| host.window.clone())
        })
    }

    pub(crate) fn presented_tab_for_source(
        &self,
        source_id: &str,
        tab_type: &str,
    ) -> Option<String> {
        self.presentation.tab_for_source(source_id, tab_type)
    }

    pub fn window_id_for_webview(&self, webview_label: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            let popup_role_id = state.popup_roles.get(webview_label);
            state.tabs.values().find_map(|tab| {
                let owns_webview = popup_role_id
                    .is_some_and(|role_id| tab.roles.contains_key(role_id))
                    || tab
                        .roles
                        .values()
                        .any(|surface| surface.webview.label() == webview_label);
                owns_webview.then(|| tab.window_id.clone())
            })
        })
    }

    pub fn prepare_provisional_game_window(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        title: &str,
    ) -> Result<(), String> {
        let (window, _) = self
            .ensure_display_host(target, title)
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
        let scale = if cfg!(windows) {
            1.0
        } else {
            window.scale_factor().unwrap_or(1.0).max(f64::EPSILON)
        };
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
        let tab_was_visible = self
            .presentation
            .existing(&source_window_id)
            .and_then(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .map(|presentation| presentation.selected_tab_id.as_deref() == Some(tab_id))
            })
            .unwrap_or(false);
        let source_window_was_visible = source_window
            .is_visible()
            .map_err(|error| error.to_string())?;
        let target_window_was_visible = target_window
            .is_visible()
            .map_err(|error| error.to_string())?;

        for surface in &surfaces {
            if let Err(error) = surface.hide() {
                let rollback_errors = self.rollback_provisional_tab_move(
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    &source_window,
                    &target_window,
                    &surfaces,
                    0,
                    false,
                    tab_was_visible,
                    source_window_was_visible,
                    target_window_was_visible,
                );
                return Err(self.provisional_move_error(error.to_string(), rollback_errors));
            }
        }
        for (index, surface) in surfaces.iter().enumerate() {
            if let Err(error) = surface.reparent(&target_window) {
                let rollback_errors = self.rollback_provisional_tab_move(
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    &source_window,
                    &target_window,
                    &surfaces,
                    index + 1,
                    false,
                    tab_was_visible,
                    source_window_was_visible,
                    target_window_was_visible,
                );
                return Err(self.provisional_move_error(error.to_string(), rollback_errors));
            }
        }
        let (source_is_empty, moved_surfaces) = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => {
                    let rollback_errors = self.rollback_provisional_tab_move(
                        tab_id,
                        &source_window_id,
                        target_window_id,
                        &source_window,
                        &target_window,
                        &surfaces,
                        surfaces.len(),
                        false,
                        tab_was_visible,
                        source_window_was_visible,
                        target_window_was_visible,
                    );
                    return Err(self.provisional_move_error(
                        "The System WebView runtime state lock was poisoned.".to_owned(),
                        rollback_errors,
                    ));
                }
            };
            let Some(tab) = state.tabs.get_mut(tab_id) else {
                drop(state);
                let rollback_errors = self.rollback_provisional_tab_move(
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    &source_window,
                    &target_window,
                    &surfaces,
                    surfaces.len(),
                    false,
                    tab_was_visible,
                    source_window_was_visible,
                    target_window_was_visible,
                );
                return Err(self.provisional_move_error(
                    "Runtime tab was not found.".to_owned(),
                    rollback_errors,
                ));
            };
            if tab.window_id != source_window_id {
                drop(state);
                let rollback_errors = self.rollback_provisional_tab_move(
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    &source_window,
                    &target_window,
                    &surfaces,
                    surfaces.len(),
                    false,
                    tab_was_visible,
                    source_window_was_visible,
                    target_window_was_visible,
                );
                return Err(self.provisional_move_error(
                    "Runtime tab moved before the provisional transaction committed.".to_owned(),
                    rollback_errors,
                ));
            }
            tab.window_id = target_window_id.to_owned();
            for surface in state.surface_registry.values_mut() {
                if surface.tab_id.as_deref() == Some(tab_id) {
                    surface.window_id = target_window_id.to_owned();
                }
            }
            let moved_surfaces = state
                .surface_registry
                .values()
                .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                .cloned()
                .collect::<Vec<_>>();
            let source_is_empty = !state
                .tabs
                .values()
                .any(|tab| tab.window_id == source_window_id);
            (source_is_empty, moved_surfaces)
        };
        for surface in &moved_surfaces {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.moved",
                "Native surface ownership moved to another window.",
                surface,
            );
        }
        let move_revision = self.presentation.next_revision();
        if let Err(message) =
            self.presentation
                .move_tab(tab_id, &source_window_id, target_window_id, move_revision)
        {
            let rollback_errors = self.rollback_provisional_tab_move(
                tab_id,
                &source_window_id,
                target_window_id,
                &source_window,
                &target_window,
                &surfaces,
                surfaces.len(),
                true,
                tab_was_visible,
                source_window_was_visible,
                target_window_was_visible,
            );
            return Err(self.provisional_move_error(message, rollback_errors));
        }
        let reveal_result = (|| {
            self.layout_runtime_tab(tab_id)
                .map_err(|error| error.message)?;
            if tab_was_visible {
                for surface in &surfaces {
                    surface.show().map_err(|error| error.to_string())?;
                }
                target_window.show().map_err(|error| error.to_string())?;
            }
            if source_is_empty {
                source_window.hide().map_err(|error| error.to_string())?;
            }
            Ok::<(), String>(())
        })();
        if let Err(message) = reveal_result {
            let rollback_errors = self.rollback_provisional_tab_move(
                tab_id,
                &source_window_id,
                target_window_id,
                &source_window,
                &target_window,
                &surfaces,
                surfaces.len(),
                true,
                tab_was_visible,
                source_window_was_visible,
                target_window_was_visible,
            );
            return Err(self.provisional_move_error(message, rollback_errors));
        }
        self.publish_projection();
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn rollback_provisional_tab_move(
        &self,
        tab_id: &str,
        source_window_id: &str,
        target_window_id: &str,
        source_window: &Window,
        target_window: &Window,
        surfaces: &[Webview],
        reparent_attempted: usize,
        state_committed: bool,
        tab_was_visible: bool,
        source_window_was_visible: bool,
        target_window_was_visible: bool,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        let mut rolled_back_surfaces = Vec::new();
        if reparent_attempted > 0 {
            for surface in surfaces {
                if let Err(error) = surface.hide() {
                    errors.push(format!("hide {}: {error}", surface.label()));
                }
            }
            for surface in surfaces.iter().take(reparent_attempted).rev() {
                if let Err(error) = surface.reparent(source_window) {
                    errors.push(format!("reparent {}: {error}", surface.label()));
                }
            }
        }
        if state_committed {
            if self
                .presentation
                .window_contains_tab(target_window_id, tab_id)
            {
                let revision = self.presentation.next_revision();
                if let Err(error) =
                    self.presentation
                        .move_tab(tab_id, target_window_id, source_window_id, revision)
                {
                    errors.push(format!("presentation rollback: {error}"));
                }
            } else if !self
                .presentation
                .window_contains_tab(source_window_id, tab_id)
            {
                errors.push("presentation tab disappeared during rollback".to_owned());
            }
            match self.state.lock() {
                Ok(mut state) => match state.tabs.get_mut(tab_id) {
                    Some(tab) if tab.window_id == target_window_id => {
                        tab.window_id = source_window_id.to_owned();
                        for surface in state.surface_registry.values_mut() {
                            if surface.tab_id.as_deref() == Some(tab_id) {
                                surface.window_id = source_window_id.to_owned();
                                rolled_back_surfaces.push(surface.clone());
                            }
                        }
                    }
                    Some(_) => errors.push("runtime tab host changed during rollback".to_owned()),
                    None => errors.push("runtime tab disappeared during rollback".to_owned()),
                },
                Err(_) => errors.push("runtime state lock was poisoned during rollback".to_owned()),
            }
            for surface in &rolled_back_surfaces {
                self.record_surface_event(
                    LogLevel::Warn,
                    "surface.move-rolled-back",
                    "Native surface ownership move was rolled back.",
                    surface,
                );
            }
            if let Err(error) = self.layout_runtime_tab(tab_id) {
                errors.push(format!("layout: {}", error.message));
            }
        }
        if tab_was_visible {
            for surface in surfaces {
                if let Err(error) = surface.show() {
                    errors.push(format!("show {}: {error}", surface.label()));
                }
            }
        }
        let source_visibility = if source_window_was_visible {
            source_window.show()
        } else {
            source_window.hide()
        };
        if let Err(error) = source_visibility {
            errors.push(format!("source window visibility: {error}"));
        }
        let target_visibility = if target_window_was_visible {
            target_window.show()
        } else {
            target_window.hide()
        };
        if let Err(error) = target_visibility {
            errors.push(format!("target window visibility: {error}"));
        }
        self.publish_projection();
        errors
    }

    fn provisional_move_error(&self, original: String, rollback_errors: Vec<String>) -> String {
        if rollback_errors.is_empty() {
            return original;
        }
        self.health.mark_unhealthy();
        provisional_move_failure_message(original, &rollback_errors)
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
        let rollback = if current_window_id.as_deref() == Some(provisional_window_id) {
            self.provisionally_move_tab(tab_id, source_window_id)
        } else {
            Ok(())
        };
        if let Some(source) = self.window_for_id(source_window_id) {
            let _ = source.show();
            let _ = source.set_focus();
        }
        self.discard_provisional_game_window(provisional_window_id);
        self.publish_projection();
        rollback
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
        self.presentation.remove(window_id);
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

    pub fn reload_tab(&self, tab_id: &str) -> Result<(), String> {
        let webviews = {
            let state = self.state().map_err(|error| error.message)?;
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| "runtime tab was not found".to_owned())?;
            let webviews = tab
                .roles
                .values()
                .map(|role| role.webview.clone())
                .collect::<Vec<_>>();
            if webviews.is_empty() {
                return Err("runtime tab has no role surface".to_owned());
            }
            webviews
        };
        reload_runtime_tab_handles(webviews, |webview| {
            webview.reload().map_err(|error| error.to_string())
        })
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
        let previous_muted = self
            .state()
            .map_err(|error| error.message)?
            .tabs
            .get(tab_id)
            .map(|tab| tab.audio_muted)
            .ok_or_else(|| "runtime tab was not found".to_owned())?;
        self.set_role_audio_muted(&role_id, muted)
            .map_err(|error| error.message)?;
        let persist_result = (|| -> Result<(), String> {
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
            Ok(())
        })();
        if let Err(error) = persist_result {
            return match self.set_role_audio_muted(&role_id, previous_muted) {
                Ok(()) => Err(error),
                Err(rollback_error) => {
                    self.health.mark_unhealthy();
                    Err(format!(
                        "{error} Native audio compensation also failed: {}. Restart Rion Studio to recover safely.",
                        rollback_error.message
                    ))
                }
            };
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
                let tab_id = tab_id.clone();
                drop(state);
                self.send_divider_indicators(&role_ids, "hide");
                self.persist_runtime_tab_role_views(&tab_id)?;
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
            let event_screen_position =
                payload
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
            let screen_position = if cfg!(windows) {
                let cursor = self
                    .app
                    .cursor_position()
                    .map_err(|error| error.to_string())?;
                if divider.axis == "vertical" {
                    cursor.x / scale
                } else {
                    cursor.y / scale
                }
            } else {
                event_screen_position
            };
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
            self.persist_runtime_tab_role_views(&tab_id)?;
        }
        Ok(())
    }

    fn persist_runtime_tab_role_views(&self, tab_id: &str) -> Result<(), String> {
        let role_views = {
            let state = self.state().map_err(|error| error.message)?;
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| "Runtime tab was not found while saving its layout.".to_owned())?;
            let mut role_views = tab
                .roles
                .iter()
                .map(|(role_id, surface)| GameWindowRoleViewRecord {
                    role_id: role_id.clone(),
                    rect: surface.rect.clone(),
                    browser_zoom_percent: (surface.zoom_factor * 100.0).clamp(25.0, 500.0),
                })
                .collect::<Vec<_>>();
            role_views.sort_by(|left, right| left.role_id.cmp(&right.role_id));
            role_views
        };
        let mut game_windows = self
            .core
            .invoke(CoreCommand::GameWindowsList)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                    .map_err(|error| error.to_string())
            })?;
        let game_window = game_windows
            .iter_mut()
            .find(|window| window.tabs.iter().any(|tab| tab.id == tab_id))
            .ok_or_else(|| "Saved Game Window was not found while saving its layout.".to_owned())?;
        let tab = game_window
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| "Saved runtime tab was not found while saving its layout.".to_owned())?;
        tab.role_views = role_views;
        self.core
            .invoke(CoreCommand::GameWindowUpdate {
                id: game_window.id.clone(),
                input: GameWindowUpdateInputRecord {
                    tabs: Some(game_window.tabs.clone()),
                    active_tab_id: Some(game_window.active_tab_id.clone()),
                    ..GameWindowUpdateInputRecord::default()
                },
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn restore_tab_role_views(
        &self,
        tab_id: &str,
        role_views: &[GameWindowRoleViewRecord],
    ) -> Result<(), String> {
        if role_views.is_empty() {
            return Ok(());
        }
        let restored = {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab = state.tabs.get_mut(tab_id).ok_or_else(|| {
                "Runtime tab was not found while restoring its layout.".to_owned()
            })?;
            let mut restored = 0;
            for view in role_views {
                if let Some(surface) = tab.roles.get_mut(&view.role_id) {
                    surface.rect = view.rect.clone();
                    surface.zoom_factor = (view.browser_zoom_percent / 100.0).clamp(0.25, 5.0);
                    surface.zoom_mode = "fixed".to_owned();
                    restored += 1;
                }
            }
            restored
        };
        if restored == 0 {
            return Err("No saved role view matched the restored runtime tab.".to_owned());
        }
        self.layout_runtime_tab(tab_id)
            .map_err(|error| error.message)
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
        let window_id = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| host.target.window_id.clone())
        };
        let Some(window_id) = window_id else {
            return Ok(false);
        };
        self.toggle_runtime_window_fullscreen(&window_id)?;
        Ok(true)
    }

    pub fn toggle_runtime_window_fullscreen(&self, window_id: &str) -> Result<(), String> {
        let window = self
            .window_for_id(window_id)
            .ok_or_else(|| "Runtime window was not found.".to_owned())?;
        let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
        #[cfg(target_os = "macos")]
        self.prepare_runtime_window_fullscreen(window.label(), !fullscreen);
        window
            .set_fullscreen(!fullscreen)
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn collect_browser_performance_diagnostics(
        &self,
        sample_duration: Duration,
    ) -> Result<BrowserPerformanceDiagnosticsRecord, String> {
        self.collect_browser_performance_diagnostics_inner(sample_duration)
            .map_err(|error| error.message)
    }

    fn collect_browser_performance_diagnostics_inner(
        &self,
        sample_duration: Duration,
    ) -> RuntimeResult<BrowserPerformanceDiagnosticsRecord> {
        let captured_at = chrono::Utc::now().to_rfc3339();
        let platform = if cfg!(target_os = "macos") {
            "macos"
        } else {
            "windows"
        }
        .to_owned();
        let sample_duration =
            sample_duration.clamp(Duration::from_millis(500), Duration::from_millis(5_000));
        let snapshot = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSnapshot)
            .map_err(|error| RuntimeError::new("PERFORMANCE_DIAGNOSTIC_FAILED", error.to_string()))
            .and_then(|value| {
                serde_json::from_value::<BrowserRuntimeSnapshot>(value).map_err(|error| {
                    RuntimeError::new("PERFORMANCE_DIAGNOSTIC_FAILED", error.to_string())
                })
            })?;
        let candidates = {
            let state = self.state()?;
            snapshot
                .windows
                .iter()
                .filter_map(|runtime_window| {
                    let tab_id = runtime_window.active_tab_id.as_deref()?;
                    let host = state.display_hosts.get(&runtime_window.window_id)?;
                    let tab = state.tabs.get(tab_id)?;
                    let surfaces = tab
                        .roles
                        .iter()
                        .map(|(role_id, surface)| PerformanceDiagnosticSurface {
                            high_refresh_rate_status: surface.high_refresh_rate_status,
                            origin: surface.current_url.as_ref().and_then(|url| {
                                let origin = url.origin().ascii_serialization();
                                (origin != "null").then_some(origin)
                            }),
                            role_id: role_id.clone(),
                            webview: surface.webview.clone(),
                        })
                        .collect::<Vec<_>>();
                    (!surfaces.is_empty()).then(|| PerformanceDiagnosticWindow {
                        focused: false,
                        surfaces,
                        window: host.window.clone(),
                        window_id: runtime_window.window_id.clone(),
                    })
                })
                .collect::<Vec<_>>()
        };
        if candidates.is_empty() {
            return Ok(
                self.store_performance_diagnostics(empty_performance_diagnostics(
                    captured_at,
                    platform,
                    BrowserPerformanceDiagnosticStatus::NoRunningRole,
                    self.configuration.macos_high_refresh_rate,
                    sample_duration,
                )),
            );
        }
        let mut visible = candidates
            .into_iter()
            .filter_map(|mut candidate| {
                let is_visible = candidate.window.is_visible().unwrap_or(false)
                    && !candidate.window.is_minimized().unwrap_or(false);
                if !is_visible {
                    return None;
                }
                candidate.focused = candidate.window.is_focused().unwrap_or(false);
                Some(candidate)
            })
            .collect::<Vec<_>>();
        if visible.is_empty() {
            return Ok(
                self.store_performance_diagnostics(empty_performance_diagnostics(
                    captured_at,
                    platform,
                    BrowserPerformanceDiagnosticStatus::NoVisibleGameWindow,
                    self.configuration.macos_high_refresh_rate,
                    sample_duration,
                )),
            );
        }
        visible.sort_by_key(|candidate| !candidate.focused);
        let selected = visible.remove(0);
        let display_refresh_rate_hz = platform_display_refresh_rate(&selected.window);
        let mut samples = selected
            .surfaces
            .into_iter()
            .map(|surface| {
                let error = surface
                    .webview
                    .eval(PERFORMANCE_DIAGNOSTIC_START_SOURCE)
                    .err()
                    .map(|error| error.to_string());
                (surface, error)
            })
            .collect::<Vec<_>>();
        thread::sleep(sample_duration);
        let pending_reads = samples
            .drain(..)
            .map(|(surface, start_error)| {
                if let Some(error) = start_error {
                    return (surface, Err(error));
                }
                let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                match surface.webview.eval_with_callback(
                    PERFORMANCE_DIAGNOSTIC_READ_SOURCE,
                    move |value| {
                        let _ = sender.send(value);
                    },
                ) {
                    Ok(()) => (surface, Ok(receiver)),
                    Err(error) => (surface, Err(error.to_string())),
                }
            })
            .collect::<Vec<_>>();
        let read_deadline = Instant::now() + Duration::from_secs(5);
        let surfaces = pending_reads
            .into_iter()
            .map(|(surface, pending)| {
                let readback = pending
                    .map_err(|error| RuntimeError::new("PERFORMANCE_DIAGNOSTIC_FAILED", error))
                    .and_then(|receiver| {
                        receiver
                            .recv_timeout(read_deadline.saturating_duration_since(Instant::now()))
                            .map_err(|_| {
                                RuntimeError::new(
                                    "PERFORMANCE_DIAGNOSTIC_TIMEOUT",
                                    "System WebView performance diagnostic timed out.",
                                )
                            })
                    })
                    .and_then(|raw| decode_performance_diagnostic_readback(&raw));
                match readback {
                    Ok(readback) => {
                        completed_performance_surface(surface, readback, display_refresh_rate_hz)
                    }
                    Err(error) => failed_performance_surface(surface, error.message),
                }
            })
            .collect::<Vec<_>>();
        Ok(
            self.store_performance_diagnostics(BrowserPerformanceDiagnosticsRecord {
                captured_at,
                platform,
                status: BrowserPerformanceDiagnosticStatus::Available,
                window_id: Some(selected.window_id),
                window_focused: selected.focused,
                display_refresh_rate_hz,
                high_refresh_rate_requested: self.configuration.macos_high_refresh_rate,
                sample_duration_ms: sample_duration.as_millis().min(u32::MAX as u128) as u32,
                surfaces,
            }),
        )
    }

    pub fn last_browser_performance_diagnostics(
        &self,
    ) -> Option<BrowserPerformanceDiagnosticsRecord> {
        self.last_performance_diagnostics
            .lock()
            .ok()
            .and_then(|record| record.clone())
    }

    fn store_performance_diagnostics(
        &self,
        record: BrowserPerformanceDiagnosticsRecord,
    ) -> BrowserPerformanceDiagnosticsRecord {
        if let Ok(mut last) = self.last_performance_diagnostics.lock() {
            *last = Some(record.clone());
        }
        record
    }

    pub fn zoom_focused_runtime(&self, action: &str) -> Result<bool, String> {
        let window_id = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .display_hosts
                .values()
                .find(|host| host.window.is_focused().unwrap_or(false))
                .map(|host| host.target.window_id.clone())
        };
        let Some(window_id) = window_id else {
            return Ok(false);
        };
        self.zoom_runtime_window(&window_id, action)
    }

    pub fn zoom_runtime_window(&self, window_id: &str, action: &str) -> Result<bool, String> {
        if !matches!(action, "in" | "out" | "reset") {
            return Err("Runtime window zoom action is invalid.".to_owned());
        }
        let current_zoom = {
            let state = self.state().map_err(|error| error.message)?;
            let Some(host) = state.display_hosts.get(window_id) else {
                return Ok(false);
            };
            host.zoom_factor
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
            .find(|window| window.window_id == *window_id)
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
                .filter(|tab| tab.window_id == *window_id)
                .flat_map(|tab| {
                    tab.roles.iter().map(|(role_id, surface)| {
                        (
                            role_id.clone(),
                            surface.webview.clone(),
                            effective_zoom_factor(surface.zoom_factor, current_zoom),
                            effective_zoom_factor(surface.zoom_factor, next_zoom),
                        )
                    })
                })
                .collect::<Vec<_>>();
            (surfaces, visible_role_ids)
        };
        let popup_surfaces = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .popup_roles
                .iter()
                .filter_map(|(label, role_id)| {
                    let tab_id = state.role_tabs.get(role_id)?;
                    let tab = state.tabs.get(tab_id)?;
                    if tab.window_id != *window_id {
                        return None;
                    }
                    let base = tab.roles.get(role_id)?.zoom_factor;
                    Some((
                        label.clone(),
                        effective_zoom_factor(base, current_zoom),
                        effective_zoom_factor(base, next_zoom),
                    ))
                })
                .collect::<Vec<_>>()
        };
        let mut zoom_mutations = surfaces
            .iter()
            .map(|(_, webview, previous_zoom, zoom)| (webview.clone(), *previous_zoom, *zoom))
            .collect::<Vec<_>>();
        for (label, previous_zoom, zoom) in popup_surfaces {
            let webview = self
                .app
                .get_webview(&label)
                .ok_or_else(|| format!("Runtime popup {label} has no live native handle."))?;
            zoom_mutations.push((webview, previous_zoom, zoom));
        }
        if let Err(failure) = apply_reversible_fanout(
            &zoom_mutations,
            |index, (webview, _, zoom)| {
                webview
                    .set_zoom(*zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
            |index, (webview, previous_zoom, _)| {
                webview
                    .set_zoom(*previous_zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_RUNTIME_ZOOM_FAILED",
                "Updating runtime window zoom",
                &failure,
            )
            .message);
        }
        let commit = (|| -> Result<(), String> {
            let mut state = self.state().map_err(|error| error.message)?;
            let host = state
                .display_hosts
                .get_mut(window_id)
                .ok_or_else(|| "Runtime window stopped while zooming.".to_owned())?;
            if host.zoom_factor != current_zoom {
                return Err("Runtime window zoom changed concurrently.".to_owned());
            }
            host.zoom_factor = next_zoom;
            Ok(())
        })();
        if let Err(error) = commit {
            let rollback_errors = rollback_reversible_fanout(
                &zoom_mutations,
                |index, (webview, previous_zoom, _)| {
                    webview
                        .set_zoom(*previous_zoom)
                        .map_err(|rollback_error| format!("surface {index}: {rollback_error}"))
                },
            );
            if !rollback_errors.is_empty() {
                self.health.mark_unhealthy();
                return Err(format!(
                    "{error} Native zoom compensation also failed: {}. Restart Rion Studio to recover safely.",
                    rollback_errors.join("; ")
                ));
            }
            return Err(error);
        }
        let label = self.window_zoom_indicator_label(next_zoom);
        for (role_id, webview, _, _) in surfaces {
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

    pub fn execute(
        &self,
        effect: CoreEffectRequest,
        presentation_revision: u64,
    ) -> CoreEffectResult {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        match self.apply(effect, presentation_revision) {
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
            let popup_labels = std::mem::take(&mut state.popup_roles)
                .into_keys()
                .collect::<Vec<_>>();
            state.audible_webviews.clear();
            state.launch_phases.clear();
            state.overlay_capabilities.clear();
            state.overlay_ready_webviews.clear();
            state.role_tabs.clear();
            state.allow_window_close_labels.extend(
                display_hosts
                    .values()
                    .map(|host| host.window.label().to_owned()),
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
        let selected_tabs = self.presentation.selected_tabs();
        let (tabs, window_inputs, saved_windows, recovery) = {
            let Ok(state) = self.state.lock() else {
                return json!({ "windows": [], "tabs": [] });
            };
            let tabs = snapshot
                .tabs
                .iter()
                .map(|tab| {
                    // The native visibility transaction is the earliest committed source for
                    // the tab the user can actually see. It intentionally leads the core
                    // snapshot while a launch navigation or another effect is still pending.
                    let active = selected_tabs
                        .get(&tab.window_id)
                        .is_some_and(|selected| selected == &tab.id);
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
                        "hidden": tab.hidden || state.optimistic_closed_tabs.contains(&tab.id),
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
                    let presented_active_tab_id = selected_tabs
                        .get(&runtime_window.window_id)
                        .filter(|tab_id| !state.optimistic_closed_tabs.contains(tab_id.as_str()))
                        .cloned()
                        .or_else(|| {
                            runtime_window
                                .active_tab_id
                                .as_ref()
                                .filter(|tab_id| {
                                    !state.optimistic_closed_tabs.contains(tab_id.as_str())
                                })
                                .cloned()
                        });
                    Some((
                        host.window.label().to_owned(),
                        runtime_window.window_id.clone(),
                        host.target.display_id,
                        host.target.work_area.clone(),
                        host.window.clone(),
                        presented_active_tab_id,
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
        // Renderer projection and native tab metadata may lag presentation, but neither path
        // owns topology or selection. Insert/replace/remove/select are committed directly by
        // WindowPresentationState and therefore never wait for Core or a game page.
        #[cfg(target_os = "macos")]
        self.sync_native_tab_metadata(&snapshot);
        #[cfg(windows)]
        self.sync_windows_tab_metadata(&snapshot);
        let _ = self
            .app
            .emit("rion://runtime-state", self.projection(&snapshot));
    }

    /// Commits selection immediately and coalesces native visibility work by window revision.
    /// Page readiness is intentionally absent from this path.
    pub(crate) fn preview_tab_activation(
        &self,
        tab_id: &str,
        native_style_applied: bool,
    ) -> Result<(String, bool, String), String> {
        let resolved_tab_id = self
            .presentation
            .resolve_tab_alias(tab_id)
            .unwrap_or_else(|| tab_id.to_owned());
        let trigger = if native_style_applied {
            "native-pointer"
        } else {
            "pointer"
        };
        if let Some(window_id) =
            self.request_provisional_tab_presentation(&resolved_tab_id, true, trigger)?
        {
            return Ok((window_id, true, resolved_tab_id));
        }
        self.request_tab_presentation(&resolved_tab_id, true, trigger)
            .map(|window_id| (window_id, false, resolved_tab_id))
    }

    fn request_provisional_tab_presentation(
        &self,
        tab_id: &str,
        focus: bool,
        trigger: &'static str,
    ) -> Result<Option<String>, String> {
        let requested_at = Instant::now();
        let (window_id, window) = {
            let state = self.state().map_err(|error| error.message)?;
            let provisional = state
                .provisional_launches
                .values()
                .find(|launch| launch.id == tab_id && !launch.cancelled)
                .cloned();
            let Some(provisional) = provisional else {
                return Ok(None);
            };
            let window_id = provisional.window_id;
            let window = state
                .display_hosts
                .get(&window_id)
                .ok_or_else(|| "Runtime display host was not found.".to_owned())?
                .window
                .clone();
            (window_id, window)
        };
        let (previous_tab_id, previous_surfaces, revision) = {
            let presentation = self.presentation.coordinator(&window_id)?;
            let revision = self.presentation.next_revision();
            let mut window_state = presentation.lock().map_err(|_| {
                "The runtime tab presentation coordinator is unavailable.".to_owned()
            })?;
            if !window_state.contains_tab(tab_id) {
                return Ok(None);
            }
            let previous_tab_id = window_state.selected_tab_id.clone();
            let previous_surfaces = window_state.surfaces(previous_tab_id.as_deref());
            window_state.select(Some(tab_id.to_owned()), revision);
            (previous_tab_id, previous_surfaces, revision)
        };
        if matches!(trigger, "native-pointer" | "shortcut") {
            self.remember_native_active_style(&window_id, Some(tab_id));
        } else if trigger != "surface-attached" {
            self.apply_native_active_style(&window_id, Some(tab_id), revision, trigger);
        }
        self.dispatch_native_presentation(
            window_id.clone(),
            Some(tab_id.to_owned()),
            revision,
            trigger,
            requested_at,
            window,
            previous_tab_id,
            previous_surfaces,
            Vec::new(),
            None,
            None,
            focus,
        );
        Ok(Some(window_id))
    }

    fn request_tab_presentation(
        &self,
        tab_id: &str,
        focus: bool,
        trigger: &'static str,
    ) -> Result<String, String> {
        self.mark_critical_activity();
        let requested_at = Instant::now();
        let (window_id, window) = {
            let state = self.state().map_err(|error| error.message)?;
            if state.optimistic_closed_tabs.contains(tab_id) {
                return Err("The runtime tab is closing.".to_owned());
            }
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
            let window_id = tab.window_id.clone();
            let window = state
                .display_hosts
                .get(&window_id)
                .ok_or_else(|| "Runtime display host was not found.".to_owned())?
                .window
                .clone();
            (window_id, window)
        };
        let (previous_tab_id, previous_surfaces, next_surfaces, active_webview, revision) = {
            let presentation = self.presentation.coordinator(&window_id)?;
            let revision = self.presentation.next_revision();
            let mut window_state = presentation.lock().map_err(|_| {
                "The runtime tab presentation coordinator is unavailable.".to_owned()
            })?;
            if !window_state.contains_tab(tab_id) {
                return Err("Runtime tab was not found in the presentation state.".to_owned());
            }
            let previous_tab_id = window_state.selected_tab_id.clone();
            let previous_surfaces = window_state.surfaces(previous_tab_id.as_deref());
            let next_surfaces = window_state.surfaces(Some(tab_id));
            let active_webview = next_surfaces.first().cloned();
            window_state.select(Some(tab_id.to_owned()), revision);
            (
                previous_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                revision,
            )
        };
        if matches!(trigger, "native-pointer" | "shortcut") {
            self.remember_native_active_style(&window_id, Some(tab_id));
        } else if trigger != "surface-attached" {
            self.apply_native_active_style(&window_id, Some(tab_id), revision, trigger);
        }
        self.dispatch_native_presentation(
            window_id.clone(),
            Some(tab_id.to_owned()),
            revision,
            trigger,
            requested_at,
            window,
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            None,
            focus,
        );
        Ok(window_id)
    }

    fn reconcile_window_presentation(
        &self,
        window_id: &str,
        trigger: &'static str,
    ) -> RuntimeResult<()> {
        let coordinator = self
            .presentation
            .coordinator(window_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        let (tab_id, revision) = {
            let selection = coordinator.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            (selection.selected_tab_id.clone(), selection.revision)
        };
        if revision == 0 {
            return Ok(());
        }
        let window = {
            let state = self.state()?;
            state
                .display_hosts
                .get(window_id)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "Runtime display host was not found.",
                    )
                })?
                .window
                .clone()
        };
        let (next_surfaces, active_webview) = {
            let presentation = coordinator.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            let next_surfaces = presentation.surfaces(tab_id.as_deref());
            let active_webview = next_surfaces.first().cloned();
            (next_surfaces, active_webview)
        };
        self.dispatch_native_presentation(
            window_id.to_owned(),
            tab_id,
            revision,
            trigger,
            Instant::now(),
            window,
            None,
            Vec::new(),
            next_surfaces,
            active_webview,
            None,
            false,
        );
        Ok(())
    }

    pub(crate) fn preview_adjacent_tab_activation(
        &self,
        window_id: &str,
        direction: &str,
    ) -> Result<(String, bool), String> {
        let (candidates, current_tab_id) = {
            let presentation = self.presentation.coordinator(window_id)?;
            let window = presentation.lock().map_err(|_| {
                "The runtime tab presentation coordinator is unavailable.".to_owned()
            })?;
            (window.tab_ids(), window.selected_tab_id.clone())
        };
        if candidates.is_empty() {
            return Err("The runtime window has no selectable tabs.".to_owned());
        }
        let current = current_tab_id
            .as_ref()
            .and_then(|active_id| candidates.iter().position(|tab_id| tab_id == active_id))
            .unwrap_or(0);
        let target_index = if direction == "previous" {
            (current + candidates.len() - 1) % candidates.len()
        } else {
            (current + 1) % candidates.len()
        };
        let target_id = candidates[target_index].clone();
        let provisional = self
            .request_provisional_tab_presentation(&target_id, true, "shortcut")?
            .is_some();
        if !provisional {
            self.request_tab_presentation(&target_id, true, "shortcut")?;
        }
        Ok((target_id, provisional))
    }

    pub(crate) fn preview_tab_close(&self, tab_id: &str) -> Result<RuntimeTabCloseIntent, String> {
        let started = Instant::now();
        let (
            window,
            window_id,
            isolation_surfaces,
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            next_tab_id,
            revision,
            source_id,
            tab_type,
        ) = {
            let (window_id, window, isolation_surfaces) = {
                let state = self.state().map_err(|error| error.message)?;
                let tab = state
                    .tabs
                    .get(tab_id)
                    .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
                let window_id = tab.window_id.clone();
                let window = state
                    .display_hosts
                    .get(&window_id)
                    .ok_or_else(|| "Runtime display host was not found.".to_owned())?
                    .window
                    .clone();
                let isolation_surfaces = state
                    .surface_registry
                    .values()
                    .filter(|surface| {
                        surface.tab_id.as_deref() == Some(tab_id)
                            && surface.kind != ManagedSurfaceKind::Divider
                            && surface.phase.blocks_role_relaunch()
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                (window_id, window, isolation_surfaces)
            };
            let (
                original_active_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                next_tab_id,
                revision,
                source_id,
                tab_type,
            ) = {
                let presentation = self.presentation.coordinator(&window_id)?;
                let revision = self.presentation.next_revision();
                let mut window_state = presentation.lock().map_err(|_| {
                    "The runtime tab presentation coordinator is unavailable.".to_owned()
                })?;
                if !window_state.contains_tab(tab_id) {
                    return Err("Runtime tab was not found in the presentation state.".to_owned());
                }
                let presentation_tab = window_state
                    .tabs
                    .iter()
                    .find(|tab| tab.id == tab_id)
                    .cloned()
                    .ok_or_else(|| "Runtime tab presentation metadata was not found.".to_owned())?;
                let original_active_tab_id = window_state.selected_tab_id.clone();
                let previous_surfaces = window_state.surfaces(original_active_tab_id.as_deref());
                let next_tab_id = if original_active_tab_id.as_deref() == Some(tab_id) {
                    successor_tab_after_close(&window_state.tab_ids(), tab_id, |_| true)
                } else {
                    original_active_tab_id.clone()
                };
                window_state.remove_tab(tab_id, revision);
                window_state.select(next_tab_id.clone(), revision);
                let next_surfaces = window_state.surfaces(next_tab_id.as_deref());
                let active_webview = next_surfaces.first().cloned();
                (
                    original_active_tab_id,
                    previous_surfaces,
                    next_surfaces,
                    active_webview,
                    next_tab_id,
                    revision,
                    presentation_tab.source_id,
                    presentation_tab.tab_type,
                )
            };
            let mut state = self.state().map_err(|error| error.message)?;
            state.optimistic_closed_tabs.insert(tab_id.to_owned());
            state.close_previews.insert(
                tab_id.to_owned(),
                CloseTransaction {
                    source_id: source_id.clone(),
                    tab_type: tab_type.clone(),
                    #[cfg(target_os = "macos")]
                    original_active_tab_id: original_active_tab_id.clone(),
                    #[cfg(target_os = "macos")]
                    revision,
                    #[cfg(target_os = "macos")]
                    window_id: window_id.clone(),
                },
            );
            (
                window,
                window_id,
                isolation_surfaces,
                original_active_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                next_tab_id,
                revision,
                source_id,
                tab_type,
            )
        };
        let elapsed = started.elapsed();
        self.apply_native_active_style(&window_id, next_tab_id.as_deref(), revision, "close");
        self.record_tab_close_presentation(tab_id, next_tab_id.as_deref(), revision, elapsed);
        self.dispatch_native_presentation(
            window_id,
            next_tab_id.clone(),
            revision,
            "close",
            started,
            window,
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            next_tab_id.is_none().then_some(false),
            true,
        );
        self.request_preview_surface_isolation(isolation_surfaces);
        Ok(RuntimeTabCloseIntent {
            source_id,
            tab_type,
        })
    }

    fn request_preview_surface_isolation(&self, surfaces: Vec<ManagedSurface>) {
        if surfaces.is_empty() {
            return;
        }
        for surface in &surfaces {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.isolation-requested-early",
                "Native isolation was requested directly from the presentation close transaction.",
                surface,
            );
        }

        #[cfg(target_os = "macos")]
        for surface in surfaces {
            // The native adapter dispatches to AppKit without waiting. This must
            // precede Core persistence so a rapid close burst takes every game
            // page offline even while metadata commits are queued.
            let _ = quiesce_platform_surface(&surface.webview, &surface.lifecycle);
        }

        #[cfg(windows)]
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::scope(|scope| {
                for surface in &surfaces {
                    scope.spawn(move || {
                        let _ = quiesce_platform_surface(&surface.webview, &surface.lifecycle);
                    });
                }
            });
        });

        #[cfg(not(any(windows, target_os = "macos")))]
        for surface in surfaces {
            let _ = quiesce_platform_surface(&surface.webview, &surface.lifecycle);
        }
    }

    pub(crate) fn resolve_tab_close_preview(&self, tab_id: &str, succeeded: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.close_previews.remove(tab_id);
            if succeeded || !state.tabs.contains_key(tab_id) {
                state.optimistic_closed_tabs.remove(tab_id);
            } else {
                let role_ids = state
                    .tabs
                    .get(tab_id)
                    .map(|tab| tab.roles.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                state.close_coordinator.quarantined_roles.extend(role_ids);
                for surface in state
                    .surface_registry
                    .values_mut()
                    .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                {
                    surface.phase = ManagedSurfacePhase::Quarantined;
                }
            }
        }
        self.publish_projection();
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn cancel_tab_close_preview(&self, tab_id: &str) {
        self.resolve_tab_close_preview(tab_id, false);
    }

    pub(crate) fn reconcile_tab_activation(&self, window_id: &str) {
        let (tab_id, revision) = self
            .presentation
            .existing(window_id)
            .and_then(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .map(|window| (window.selected_tab_id.clone(), window.revision))
            })
            .unwrap_or((None, 0));
        self.record_presentation_event(
            LogLevel::Warn,
            "tab.selection-persist-failed",
            "The visual tab selection was retained after metadata persistence failed.",
            window_id,
            tab_id.as_deref(),
            revision,
            "persistence",
            0,
        );
    }

    pub(crate) fn tab_selection_is_desired(&self, window_id: &str, tab_id: &str) -> bool {
        self.presentation
            .existing(window_id)
            .and_then(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .map(|window| window.selected_tab_id.as_deref() == Some(tab_id))
            })
            .unwrap_or(false)
    }

    fn snapshot_with_native_tab_locations(
        &self,
        mut snapshot: BrowserRuntimeSnapshot,
    ) -> BrowserRuntimeSnapshot {
        let selected_tabs = self.presentation.selected_tabs();
        let Ok(state) = self.state.lock() else {
            return snapshot;
        };
        let native_locations = state
            .tabs
            .iter()
            .map(|(tab_id, tab)| (tab_id.as_str(), tab.window_id.as_str()))
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
            if selected_tabs
                .get(&tab.window_id)
                .is_some_and(|selected| selected == &tab.id)
                && !state.optimistic_closed_tabs.contains(&tab.id)
            {
                window.active_tab_id = Some(tab.id.clone());
            }
        }
        for window in &mut snapshot.windows {
            if window.active_tab_id.is_none() {
                window.active_tab_id = window
                    .tab_ids
                    .iter()
                    .find(|tab_id| !state.optimistic_closed_tabs.contains(tab_id.as_str()))
                    .cloned();
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

    pub(crate) fn handle_window_close_requested(&self, label: &str) -> RuntimeResult<bool> {
        let window = {
            let mut state = self.state()?;
            if state.allow_window_close_labels.remove(label) {
                return Ok(false);
            }
            let Some(window) = state
                .display_hosts
                .values()
                .find(|host| host.window.label() == label)
                .map(|host| host.window.clone())
            else {
                return Ok(false);
            };
            window
        };
        let was_visible = window.is_visible().map_err(RuntimeError::tauri)?;
        let result = apply_window_close_to_hide_transaction(
            || {
                self.persist_game_window_placement(label).map_err(|error| {
                    format!("Could not persist the game window placement: {error}")
                })
            },
            || {
                window
                    .hide()
                    .map_err(|error| format!("Could not hide the game window: {error}"))
            },
            || {
                self.persist_restore_session(false).map_err(|error| {
                    format!("Could not persist the runtime restore session: {error}")
                })
            },
            || {
                if was_visible {
                    window.show().map_err(|error| error.to_string())
                } else {
                    Ok(())
                }
            },
        );
        if let Err(failure) = result {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_RUNTIME_WINDOW_CLOSE_FAILED",
                "Closing the runtime window",
                &failure,
            ));
        }
        if let Ok(mut state) = self.state.lock() {
            state.pending_window_close_labels.remove(label);
        }
        self.publish_projection();
        Ok(true)
    }

    pub fn resize_window(&self, label: &str, physical_width: u32, physical_height: u32) -> bool {
        let Some((window_id, window)) = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .iter()
                .find(|(_, host)| host.window.label() == label)
                .map(|(window_id, host)| (window_id.clone(), host.window.clone()))
        }) else {
            return false;
        };
        if !runtime_window_resize_is_actionable(
            physical_width,
            physical_height,
            window.is_minimized().unwrap_or(false),
        ) {
            return false;
        }
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
        let mut layout_errors = Vec::new();
        for tab_id in tab_ids {
            if let Err(error) = self.layout_runtime_tab(&tab_id) {
                layout_errors.push(format!("{tab_id}: {}: {}", error.code, error.message));
            }
        }
        if !layout_errors.is_empty() {
            self.emit_runtime_shell_error(
                "TAURI_RUNTIME_WINDOW_LAYOUT_FAILED",
                layout_errors.join("; "),
                label,
            );
        }
        self.publish_projection();
        true
    }

    pub fn move_window(self: &Arc<Self>, label: &str, physical_x: i32, physical_y: i32) {
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
                    let scale = monitor.scale_factor().max(f64::EPSILON);
                    let work_area = monitor.work_area();
                    (
                        super::monitor_id(&monitor),
                        StatePixelBoundsRecord {
                            x: (work_area.position.x as f64 / scale).round() as i32,
                            y: (work_area.position.y as f64 / scale).round() as i32,
                            width: (work_area.size.width as f64 / scale).round() as i32,
                            height: (work_area.size.height as f64 / scale).round() as i32,
                        },
                        scale,
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
            if let Some((display_id, work_area, scale_factor)) = monitor_target {
                host.target.display_id = display_id;
                host.target.work_area = work_area;
                host.target.scale_factor = scale_factor;
            }
        }
        self.schedule_window_placement_persistence(label.to_owned());
    }

    pub fn relocate_game_window(&self, target: EmbeddedLaunchTargetRecord) -> Result<(), String> {
        self.relocate_game_window_if_live(target).map(|_| ())
    }

    pub fn relocate_game_window_if_live(
        &self,
        target: EmbeddedLaunchTargetRecord,
    ) -> Result<bool, String> {
        let Some(window) = self.window_for_id(&target.window_id) else {
            return Ok(false);
        };
        if window.is_fullscreen().unwrap_or(false) {
            window
                .set_fullscreen(false)
                .map_err(|error| error.to_string())?;
        }
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|error| error.to_string())?;
        }
        let (physical_x, physical_y) =
            physical_window_position(target.bounds.x, target.bounds.y, target.scale_factor);
        window
            .set_position(PhysicalPosition::new(physical_x, physical_y))
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
        Ok(true)
    }

    pub fn focus_window(self: &Arc<Self>, label: &str) {
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
        self.schedule_window_placement_persistence(label.to_owned());
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
                    if runtime.resize_window(&worker_label, width, height) {
                        runtime.schedule_window_placement_persistence(worker_label.clone());
                    }
                }
            })
            .is_err()
            && let Ok(mut state) = self.state.lock()
        {
            state.active_window_resize_workers.remove(&label);
            state.pending_window_resizes.remove(&label);
        }
    }

    fn schedule_window_placement_persistence(self: &Arc<Self>, label: String) {
        let sequence = WINDOW_PLACEMENT_PERSIST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let should_spawn = self.state.lock().ok().is_some_and(|mut state| {
            state
                .pending_window_placement_writes
                .insert(label.clone(), sequence);
            state.active_window_placement_workers.insert(label.clone())
        });
        if !should_spawn {
            return;
        }
        let runtime = Arc::clone(self);
        let worker_label = label.clone();
        let spawn_result = thread::Builder::new()
            .name("rion-runtime-window-placement".to_owned())
            .spawn(move || {
                let mut observed = sequence;
                loop {
                    thread::sleep(WINDOW_PLACEMENT_PERSIST_DEBOUNCE);
                    let settled = runtime.state.lock().ok().is_none_or(|mut state| {
                        let current = state
                            .pending_window_placement_writes
                            .get(&worker_label)
                            .copied();
                        if current.is_some_and(|current| current != observed) {
                            observed = current.expect("checked placement sequence");
                            return false;
                        }
                        state.pending_window_placement_writes.remove(&worker_label);
                        state.active_window_placement_workers.remove(&worker_label);
                        true
                    });
                    if !settled {
                        continue;
                    }
                    if let Err(error) = runtime.persist_game_window_placement(&worker_label) {
                        runtime.emit_runtime_shell_error(
                            "TAURI_RUNTIME_WINDOW_PERSIST_FAILED",
                            error,
                            &worker_label,
                        );
                    }
                    break;
                }
            });
        if spawn_result.is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.active_window_placement_workers.remove(&label);
                state.pending_window_placement_writes.remove(&label);
            }
            if let Err(error) = self.persist_game_window_placement(&label) {
                self.emit_runtime_shell_error("TAURI_RUNTIME_WINDOW_PERSIST_FAILED", error, &label);
            }
        }
    }

    fn emit_runtime_shell_error(&self, code: &str, message: String, label: &str) {
        let _ = self.app.emit(
            "rion://shell-error",
            json!({ "code": code, "message": message, "windowLabel": label }),
        );
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
        prepare_restore_session_for_persist(&mut session, clean_exit);
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

    pub fn refresh_browser_fonts(&self) {
        let (mut webviews, popup_labels) = {
            let Ok(state) = self.state.lock() else {
                return;
            };
            let webviews = state
                .tabs
                .values()
                .flat_map(|tab| tab.roles.values())
                .map(|surface| surface.webview.clone())
                .collect::<Vec<_>>();
            let popup_labels = state.popup_roles.keys().cloned().collect::<Vec<_>>();
            (webviews, popup_labels)
        };

        for label in popup_labels {
            if let Some(webview) = self.app.get_webview(&label) {
                webviews.push(webview);
            }
        }
        refresh_macro_overlay_handles(webviews, |webview| {
            webview.eval(BROWSER_FONTS_REFRESH_SOURCE)
        });
    }

    pub fn role_id_for_webview(&self, webview_label: &str) -> Result<String, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        if state
            .close_coordinator
            .closing_webviews
            .contains(webview_label)
        {
            return Err("Overlay WebView is closing.".to_owned());
        }
        if let Some(role_id) = state.popup_roles.get(webview_label) {
            if state.close_coordinator.closing_roles.contains(role_id) {
                return Err("Overlay role is closing.".to_owned());
            }
            return Ok(role_id.clone());
        }
        state
            .role_tabs
            .iter()
            .find_map(|(role_id, tab_id)| {
                state.tabs.get(tab_id).and_then(|tab| {
                    tab.roles
                        .get(role_id)
                        .filter(|surface| {
                            surface.webview.label() == webview_label
                                && !state.close_coordinator.closing_roles.contains(role_id)
                        })
                        .map(|_| role_id.clone())
                })
            })
            .ok_or_else(|| "Overlay WebView is not associated with a running role.".to_owned())
    }

    pub fn authorize_overlay_request(
        &self,
        webview_label: &str,
        capability: &str,
    ) -> Result<String, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        if state
            .close_coordinator
            .closing_webviews
            .contains(webview_label)
        {
            return Err("The overlay WebView is closing.".to_owned());
        }
        if state
            .overlay_capabilities
            .get(webview_label)
            .map(String::as_str)
            != Some(capability)
        {
            return Err("The overlay capability is missing or no longer valid.".to_owned());
        }
        if let Some(role_id) = state.popup_roles.get(webview_label) {
            if state.close_coordinator.closing_roles.contains(role_id) {
                return Err("The overlay role is closing.".to_owned());
            }
            return Ok(role_id.clone());
        }
        state
            .role_tabs
            .iter()
            .find_map(|(role_id, tab_id)| {
                state.tabs.get(tab_id).and_then(|tab| {
                    tab.roles
                        .get(role_id)
                        .filter(|surface| {
                            surface.webview.label() == webview_label
                                && !state.close_coordinator.closing_roles.contains(role_id)
                        })
                        .map(|_| role_id.clone())
                })
            })
            .ok_or_else(|| "Overlay WebView is not associated with a running role.".to_owned())
    }

    pub fn mark_overlay_ready(&self, webview_label: &str, capability: &str) -> Result<(), String> {
        self.authorize_overlay_request(webview_label, capability)?;
        let inserted = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .overlay_ready_webviews
            .insert(webview_label.to_owned());
        if inserted {
            self.record_runtime_stage(
                format!("overlay-ready:{webview_label}"),
                "completed",
                Instant::now(),
            );
        }
        Ok(())
    }

    fn overlay_document_start_script_for_label(&self, label: &str) -> RuntimeResult<String> {
        let capability = {
            let mut state = self.state()?;
            state
                .overlay_capabilities
                .entry(label.to_owned())
                .or_insert_with(|| uuid::Uuid::new_v4().to_string())
                .clone()
        };
        macro_overlay_document_start_script(
            &self.configuration.overlay_document_start_script_template,
            &capability,
        )
        .map_err(|message| RuntimeError::new("SYSTEM_OVERLAY_SCRIPT_INVALID", message))
    }

    fn revoke_overlay_capability(&self, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.overlay_capabilities.remove(label);
            state.overlay_ready_webviews.remove(label);
        }
    }

    #[cfg(target_os = "macos")]
    fn failure_target_for_webview(&self, webview_label: &str) -> Option<SurfaceFailureTarget> {
        let state = self.state.lock().ok()?;
        if let Some(role_id) = state.popup_roles.get(webview_label) {
            let tab_id = state.role_tabs.get(role_id)?;
            let generation = state.tabs.get(tab_id)?.roles.get(role_id)?.generation;
            return Some(SurfaceFailureTarget::Popup {
                label: webview_label.to_owned(),
                role_id: role_id.clone(),
                generation,
            });
        }
        state.role_tabs.iter().find_map(|(role_id, tab_id)| {
            state.tabs.get(tab_id).and_then(|tab| {
                tab.roles
                    .get(role_id)
                    .filter(|surface| surface.webview.label() == webview_label)
                    .map(|surface| SurfaceFailureTarget::Role {
                        role_id: role_id.clone(),
                        generation: surface.generation,
                    })
            })
        })
    }

    fn claim_surface_generation(&self, role_id: &str) -> RuntimeResult<u64> {
        let mut state = self.state()?;
        let generation = state
            .recovery_generations
            .entry(role_id.to_owned())
            .or_insert(0);
        *generation = generation.saturating_add(1);
        Ok(*generation)
    }

    fn surface_generation_for_role(&self, role_id: &str) -> Option<u64> {
        let state = self.state.lock().ok()?;
        if state.close_coordinator.closing_roles.contains(role_id) {
            return None;
        }
        let tab_id = state.role_tabs.get(role_id)?;
        state
            .tabs
            .get(tab_id)?
            .roles
            .get(role_id)
            .map(|surface| surface.generation)
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
        let (
            tab_id,
            workspace_id,
            window_zoom_factor,
            previous_base_zoom_factor,
            base_zoom_factor,
            webviews,
        ) = {
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
                surface.zoom_factor,
                next_zoom_factor(surface.zoom_factor, action, 0.25, 3.0),
                webviews,
            )
        };
        let previous_effective_zoom =
            effective_zoom_factor(previous_base_zoom_factor, window_zoom_factor);
        let effective_zoom = effective_zoom_factor(base_zoom_factor, window_zoom_factor);
        if let Err(failure) = apply_reversible_fanout(
            &webviews,
            |index, webview| {
                webview
                    .set_zoom(effective_zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
            |index, webview| {
                webview
                    .set_zoom(previous_effective_zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_RUNTIME_ZOOM_FAILED",
                "Updating role zoom",
                &failure,
            )
            .message);
        }
        let commit = (|| -> Result<(), String> {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let surface = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.roles.get_mut(&role_id))
                .ok_or_else(|| "Runtime role stopped while zooming.".to_owned())?;
            if surface.zoom_factor != previous_base_zoom_factor {
                return Err("Runtime role zoom changed concurrently.".to_owned());
            }
            surface.zoom_factor = base_zoom_factor;
            surface.zoom_mode = "fixed".to_owned();
            Ok(())
        })();
        if let Err(error) = commit {
            let rollback_errors = rollback_reversible_fanout(&webviews, |index, webview| {
                webview
                    .set_zoom(previous_effective_zoom)
                    .map_err(|rollback_error| format!("surface {index}: {rollback_error}"))
            });
            if !rollback_errors.is_empty() {
                self.health.mark_unhealthy();
                return Err(format!(
                    "{error} Native zoom compensation also failed: {}. Restart Rion Studio to recover safely.",
                    rollback_errors.join("; ")
                ));
            }
            return Err(error);
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
        let Some(target) = self.failure_target_for_webview(webview_label) else {
            return;
        };
        self.handle_surface_process_failure(
            target,
            reason.to_owned(),
            SurfaceFailureScope::Renderer,
        );
    }

    fn handle_surface_process_failure(
        self: &Arc<Self>,
        target: SurfaceFailureTarget,
        reason: String,
        scope: SurfaceFailureScope,
    ) {
        match surface_failure_action(&target, scope) {
            SurfaceFailureAction::RecoverRole => {
                let (role_id, generation) = match target {
                    SurfaceFailureTarget::Role {
                        role_id,
                        generation,
                    }
                    | SurfaceFailureTarget::Popup {
                        role_id,
                        generation,
                        ..
                    } => (role_id, generation),
                };
                self.schedule_surface_recovery(role_id, reason, generation);
            }
            SurfaceFailureAction::ClosePopup => {
                let SurfaceFailureTarget::Popup {
                    label,
                    role_id,
                    generation,
                } = target
                else {
                    return;
                };
                self.close_failed_popup(&label, &role_id, generation, &reason);
            }
        }
    }

    fn close_failed_popup(&self, label: &str, role_id: &str, generation: u64, reason: &str) {
        let current = self.state.lock().ok().is_some_and(|state| {
            state.popup_roles.get(label).map(String::as_str) == Some(role_id)
                && state.role_tabs.get(role_id).is_some_and(|tab_id| {
                    state
                        .tabs
                        .get(tab_id)
                        .and_then(|tab| tab.roles.get(role_id))
                        .is_some_and(|surface| surface.generation == generation)
                })
        });
        if !current {
            return;
        }

        let close_error = self
            .app
            .get_webview_window(label)
            .map(|window| window.close().map_err(|error| error.to_string()))
            .unwrap_or(Ok(()))
            .err();
        if close_error.is_none() {
            self.forget_popup(label);
        }
        let _ = self.app.emit(
            "rion://shell-error",
            json!({
                "code": "SYSTEM_POPUP_PROCESS_FAILED",
                "message": "A popup WebView process failed and the popup was isolated from its healthy role surface.",
                "roleId": role_id,
                "webviewLabel": label,
                "reason": reason,
                "closeError": close_error
            }),
        );
    }

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

    fn rebuild_role_surface(&self, role_id: &str) -> RuntimeResult<()> {
        {
            let state = self.state()?;
            if state.close_coordinator.closing_roles.contains(role_id)
                || state.close_coordinator.quarantined_roles.contains(role_id)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "The role is closing or quarantined and cannot be recovered until Rion Studio restarts.",
                ));
            }
        }
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_LANE_POISONED",
                "The localStorage synchronization lifecycle lane is unavailable.",
            )
        })?;
        let (
            tab_id,
            window_id,
            window,
            old_surface_instance_id,
            old_webview_label,
            expected_generation,
            rect,
            current_url,
            local_storage_sync,
            zoom_factor,
            zoom_mode,
            window_zoom_factor,
            audio_muted,
            generation,
        ) = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found during System WebView recovery.",
                )
            })?;
            let (
                window_id,
                old_surface_instance_id,
                old_webview_label,
                expected_generation,
                rect,
                current_url,
                local_storage_sync,
                zoom_factor,
                zoom_mode,
                audio_muted,
            ) = {
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
                    role.surface_instance_id.clone(),
                    role.webview.label().to_owned(),
                    role.generation,
                    role.rect.clone(),
                    current_url,
                    role.local_storage_sync.clone(),
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
            let generation = state
                .recovery_generations
                .get(role_id)
                .copied()
                .unwrap_or(expected_generation)
                .max(expected_generation)
                .saturating_add(1);
            (
                tab_id,
                window_id,
                window,
                old_surface_instance_id,
                old_webview_label,
                expected_generation,
                rect,
                current_url,
                local_storage_sync,
                zoom_factor,
                zoom_mode,
                window_zoom_factor,
                audio_muted,
                generation,
            )
        };
        let local_storage_sync = local_storage_sync.map(|mut config| {
            config.generation = config.generation.saturating_add(1);
            config.token = uuid::Uuid::new_v4().to_string();
            config
        });
        let navigation = Arc::new(NavigationTracker::default());
        let callback_navigation = Arc::clone(&navigation);
        let paths = role_session_paths(&self.user_data_dir, role_id)?;
        fs::create_dir_all(&paths.webview2).map_err(RuntimeError::io)?;
        let mut builder = self
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
        if let Some(config) = local_storage_sync.as_ref() {
            builder = builder
                .initialization_script_for_all_frames(&local_storage_sync_observer_script(config)?);
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
        let bounds = role_bounds_for_content(runtime_window_content_metrics(&window)?, &rect);
        let webview = self.add_child_bounded(
            &window,
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
            role_id,
        )?;
        let high_refresh_rate_status = configure_platform_high_refresh_rate(
            &webview,
            self.configuration.macos_high_refresh_rate,
        );
        let lifecycle = match self.install_surface_lifecycle_tracker(&webview) {
            Ok(lifecycle) => lifecycle,
            Err(error) => {
                let _ = webview.close();
                return Err(error);
            }
        };
        let replacement_instance_id = match self.register_managed_surface(
            &webview,
            &lifecycle,
            ManagedSurfaceKind::Recovery,
            ManagedSurfacePhase::Provisional,
            Some(role_id),
            Some(&tab_id),
            &window_id,
            generation,
        ) {
            Ok(instance_id) => instance_id,
            Err(error) => {
                let _ = webview.close();
                return Err(error);
            }
        };
        let preparation = (|| -> RuntimeResult<()> {
            // The replacement remains about:blank until the old native surface is gone.
            webview.hide().map_err(RuntimeError::tauri)?;
            install_platform_security_policy(&webview)?;
            install_document_navigation_macro_release_handler(&webview, self.app.clone(), role_id)?;
            install_role_zoom_shortcut_handler(&webview, self.app.clone())?;
            install_process_failure_monitor(
                &webview,
                self.app.clone(),
                SurfaceFailureTarget::Role {
                    role_id: role_id.to_owned(),
                    generation,
                },
            )?;
            webview
                .set_zoom(effective_zoom_factor(zoom_factor, window_zoom_factor))
                .map_err(RuntimeError::tauri)?;
            Ok(())
        })();
        if let Err(error) = preparation {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }
        let replacement_label = webview.label().to_owned();
        let popup_labels = (|| -> RuntimeResult<Vec<String>> {
            let state = self.state()?;
            let active_tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role stopped while its System WebView was recovering.",
                )
            })?;
            let active_surface = state
                .tabs
                .get(active_tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role stopped while its System WebView was recovering.",
                    )
                })?;
            if active_tab_id != &tab_id
                || active_surface.surface_instance_id != old_surface_instance_id
                || !surface_recovery_swap_is_current(
                    active_surface.webview.label(),
                    &old_webview_label,
                    active_surface.generation,
                    expected_generation,
                )
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RECOVERY_STALE",
                    "A newer System WebView surface superseded this recovery attempt.",
                ));
            }
            Ok(state
                .popup_roles
                .iter()
                .filter(|(_, popup_role_id)| *popup_role_id == role_id)
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>())
        })();
        let popup_labels = match popup_labels {
            Ok(labels) => labels,
            Err(error) => {
                let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
                return Err(error);
            }
        };

        for label in popup_labels {
            if let Err(error) = self.close_popup_and_wait(&label, role_id) {
                let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
                return Err(error);
            }
            self.forget_popup(&label);
        }

        if let Err(error) =
            self.set_managed_surface_phase(&old_surface_instance_id, ManagedSurfacePhase::Retired)
        {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }
        let old_close = self.close_managed_surface_and_wait(&old_surface_instance_id, role_id);
        if let Err(error) = old_close {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }

        let controlled_label = replacement_label.clone();
        let replacement_surface = self.managed_surface(&replacement_instance_id)?;
        let navigation_start = (|| -> RuntimeResult<()> {
            let _native_lifecycle_guard = replacement_surface
                .native_lifecycle_lane
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_LIFECYCLE_UNAVAILABLE",
                        "The native surface lifecycle lane is unavailable.",
                    )
                })?;
            let close_fenced = {
                let state = self.state()?;
                state.close_coordinator.closing_roles.contains(role_id)
                    || state.close_coordinator.quarantined_roles.contains(role_id)
                    || state
                        .surface_registry
                        .get(&replacement_instance_id)
                        .is_none_or(|surface| surface.phase != ManagedSurfacePhase::Provisional)
            };
            if close_fenced {
                Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RECOVERY_STALE",
                    "The role began closing before its replacement surface could navigate.",
                ))
            } else {
                self.begin_controlled_navigation(&controlled_label)?;
                navigation.reset();
                webview
                    .navigate(current_url.clone())
                    .map_err(RuntimeError::tauri)
            }
        })();
        let navigation_result = navigation_start.and_then(|()| {
            navigation
                .wait()
                .map_err(|message| RuntimeError::new("SYSTEM_SURFACE_RECOVERY_FAILED", message))
        });
        self.finish_controlled_navigations(&[controlled_label]);
        if let Err(error) = navigation_result {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }
        let presentation_result = (|| -> RuntimeResult<()> {
            let _native_lifecycle_guard = replacement_surface
                .native_lifecycle_lane
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_LIFECYCLE_UNAVAILABLE",
                        "The native surface lifecycle lane is unavailable.",
                    )
                })?;
            let state = self.state()?;
            if state.close_coordinator.closing_roles.contains(role_id)
                || state.close_coordinator.quarantined_roles.contains(role_id)
                || state
                    .surface_registry
                    .get(&replacement_instance_id)
                    .is_none_or(|surface| surface.phase != ManagedSurfacePhase::Provisional)
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RECOVERY_STALE",
                    "The role began closing before its replacement surface could be shown.",
                ));
            }
            drop(state);
            if audio_muted {
                set_audio_muted(&webview, true)?;
            }
            Ok(())
        })();
        if let Err(error) = presentation_result {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(error);
        }

        let mut state = self.state()?;
        let active_tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
            RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime role stopped while its System WebView was recovering.",
            )
        })?;
        let active_surface = state
            .tabs
            .get(&active_tab_id)
            .and_then(|tab| tab.roles.get(role_id))
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role stopped while its System WebView was recovering.",
                )
            })?;
        if state.close_coordinator.closing_roles.contains(role_id)
            || state.close_coordinator.quarantined_roles.contains(role_id)
            || active_tab_id != tab_id
            || active_surface.surface_instance_id != old_surface_instance_id
            || !surface_recovery_swap_is_current(
                active_surface.webview.label(),
                &old_webview_label,
                active_surface.generation,
                expected_generation,
            )
        {
            drop(state);
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_RECOVERY_STALE",
                "A newer System WebView surface superseded this recovery attempt.",
            ));
        }
        let replacement_webview = webview.clone();
        state
            .tabs
            .get_mut(&tab_id)
            .expect("the recovery tab was validated above")
            .roles
            .insert(
                role_id.to_owned(),
                RoleSurface {
                    current_url: Some(current_url),
                    generation,
                    high_refresh_rate_status,
                    lifecycle,
                    local_storage_sync,
                    local_storage_sync_sequence: 0,
                    navigation,
                    rect,
                    surface_instance_id: replacement_instance_id.clone(),
                    webview,
                    zoom_factor,
                    zoom_mode,
                },
            );
        state
            .recovery_generations
            .insert(role_id.to_owned(), generation);
        if let Some(surface) = state.surface_registry.get_mut(&replacement_instance_id) {
            surface.kind = ManagedSurfaceKind::Role;
            surface.phase = ManagedSurfacePhase::Live;
        }
        drop(state);
        let surface_bound = self
            .presentation
            .existing(&window_id)
            .and_then(|presentation| {
                presentation.lock().ok().map(|mut presentation| {
                    let bound = presentation.bind_surface(
                        &tab_id,
                        SurfacePresentationBinding {
                            generation,
                            instance_id: replacement_instance_id.clone(),
                            webview: replacement_webview.clone(),
                        },
                    );
                    (
                        bound,
                        presentation.selected_tab_id.as_deref() == Some(tab_id.as_str()),
                    )
                })
            })
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation disappeared before recovery could bind its replacement surface.",
                )
            })?;
        if !surface_bound.0 {
            let _ = self.close_managed_surface_and_wait(&replacement_instance_id, role_id);
            return Err(RuntimeError::new(
                "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                "The runtime tab closed before recovery could bind its replacement surface.",
            ));
        }
        if surface_bound.1 {
            let _ = self.request_tab_presentation(&tab_id, false, "surface-recovered");
        } else {
            let _ = replacement_webview.hide();
        }
        if let Ok(surface) = self.managed_surface(&replacement_instance_id) {
            self.record_surface_event(
                LogLevel::Info,
                "surface.recovered",
                "Replacement native surface activated after the old surface was released.",
                &surface,
            );
        }
        Ok(())
    }

    fn apply(
        &self,
        effect: CoreEffectRequest,
        presentation_revision: u64,
    ) -> RuntimeResult<Option<String>> {
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
                    // Isolation is the close transaction's commit boundary. A
                    // rapid X burst may already have removed or marked this
                    // successor as closing by the time the native close effect
                    // finishes. Focus/visibility is presentation-only and must
                    // never turn an already successful close into a failed Core
                    // effect that strands roles in `stopping`.
                    if let Err(error) = self.show_tab(&next_tab_id, true) {
                        let window_id = self
                            .state
                            .lock()
                            .ok()
                            .and_then(|state| {
                                state
                                    .tabs
                                    .get(&next_tab_id)
                                    .map(|tab| tab.window_id.clone())
                            })
                            .unwrap_or_default();
                        self.record_presentation_event(
                            LogLevel::Debug,
                            "tab.close-successor-superseded",
                            "The close successor was superseded by a newer presentation revision.",
                            &window_id,
                            Some(&next_tab_id),
                            presentation_revision,
                            "effect",
                            0,
                        );
                        eprintln!(
                            "Native close successor presentation was superseded (tab={next_tab_id}, error={}).",
                            error.message
                        );
                    }
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
                    presentation_revision,
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
        let popup_high_refresh_rate = self.configuration.macos_high_refresh_rate;
        #[cfg(windows)]
        let popup_additional_browser_arguments =
            self.configuration.additional_browser_arguments.clone();
        let popup_base_document_start_script = self.configuration.document_start_script.clone();
        let overlay_document_start_script = role_id
            .map(|_| self.overlay_document_start_script_for_label(&label))
            .transpose()?;
        let download_app = self.app.clone();
        let download_role_id = role_id.map(str::to_owned);
        let navigation_role_id = role_id.map(str::to_owned);
        let navigation_app = self.app.clone();
        let navigation_label = label.clone();
        let mut builder = WebviewBuilder::new(label, WebviewUrl::External(blank))
            .data_directory(paths.webview2.clone())
            .data_store_identifier(paths.webkit_identifier)
            .initialization_script_for_all_frames(&self.configuration.document_start_script)
            .enable_clipboard_access()
            .zoom_hotkeys_enabled(false)
            .on_navigation(move |url| {
                let Some(role_id) = navigation_role_id.as_deref() else {
                    return matches!(url.scheme(), "about" | "http" | "https");
                };
                navigation_app
                    .try_state::<crate::CoreState>()
                    .is_some_and(|state| {
                        state.runtime.allow_navigation_after_macro_release(
                            &navigation_label,
                            role_id,
                            url,
                        )
                    })
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
                let overlay_document_start_script =
                    match popup_app.try_state::<crate::CoreState>().map(|state| {
                        state
                            .runtime
                            .overlay_document_start_script_for_label(&label)
                    }) {
                        Some(Ok(source)) => source,
                        Some(Err(error)) => {
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
                        None => return NewWindowResponse::Deny,
                    };
                let popup_document_start_script = [
                    popup_base_document_start_script.clone(),
                    overlay_document_start_script,
                ]
                .join("\n");
                let blank = match "about:blank".parse() {
                    Ok(blank) => blank,
                    Err(_) => return NewWindowResponse::Deny,
                };
                let popup_download_app = popup_app.clone();
                let popup_download_role_id = role_id.clone();
                let popup_navigation_app = popup_app.clone();
                let popup_navigation_role_id = role_id.clone();
                let popup_navigation_label = label.clone();
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
                .on_navigation(move |target| {
                    popup_navigation_app
                        .try_state::<crate::CoreState>()
                        .is_some_and(|state| {
                            state.runtime.allow_navigation_after_macro_release(
                                &popup_navigation_label,
                                &popup_navigation_role_id,
                                target,
                            )
                        })
                })
                .on_download(move |_webview, event| {
                    handle_browser_download(
                        &popup_download_app,
                        Some(&popup_download_role_id),
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
                        configure_platform_high_refresh_rate(
                            window.as_ref(),
                            popup_high_refresh_rate,
                        );
                        if let Err(error) = install_platform_security_policy(window.as_ref())
                            .and_then(|()| {
                                install_document_navigation_macro_release_handler(
                                    window.as_ref(),
                                    popup_app.clone(),
                                    role_id,
                                )
                            })
                        {
                            let _ = window.close();
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                            }
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
                        let generation = popup_app
                            .try_state::<crate::CoreState>()
                            .and_then(|state| state.runtime.surface_generation_for_role(role_id));
                        let Some(generation) = generation else {
                            let _ = window.close();
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                            }
                            return NewWindowResponse::Deny;
                        };
                        let lifecycle =
                            match popup_app.try_state::<crate::CoreState>().map(|state| {
                                state
                                    .runtime
                                    .install_surface_lifecycle_tracker(window.as_ref())
                            }) {
                                Some(Ok(lifecycle)) => lifecycle,
                                Some(Err(error)) => {
                                    let _ = window.close();
                                    if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                        state.runtime.revoke_overlay_capability(&label);
                                    }
                                    let _ = popup_app.emit(
                                        "rion://shell-error",
                                        json!({
                                            "code": error.code,
                                            "message": error.message,
                                            "roleId": role_id
                                        }),
                                    );
                                    return NewWindowResponse::Deny;
                                }
                                None => {
                                    let _ = window.close();
                                    return NewWindowResponse::Deny;
                                }
                            };
                        if let Err(error) = install_process_failure_monitor(
                            window.as_ref(),
                            popup_app.clone(),
                            SurfaceFailureTarget::Popup {
                                label: label.clone(),
                                role_id: role_id.clone(),
                                generation,
                            },
                        ) {
                            let _ = window.close();
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                            }
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
                            if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                state.runtime.revoke_overlay_capability(&label);
                            }
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
                        match popup_app.try_state::<crate::CoreState>().map(|state| {
                            state.runtime.register_popup(
                                window.as_ref(),
                                &lifecycle,
                                label.clone(),
                                role_id.clone(),
                                generation,
                            )
                        }) {
                            Some(Ok(())) => {}
                            Some(Err(error)) => {
                                let _ = window.close();
                                if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                                    state.runtime.revoke_overlay_capability(&label);
                                }
                                let _ = popup_app.emit(
                                    "rion://shell-error",
                                    json!({
                                        "code": error.code,
                                        "message": error.message,
                                        "roleId": role_id
                                    }),
                                );
                                return NewWindowResponse::Deny;
                            }
                            None => {
                                let _ = window.close();
                                return NewWindowResponse::Deny;
                            }
                        }
                        NewWindowResponse::Create { window }
                    }
                    Err(error) => {
                        if let Some(state) = popup_app.try_state::<crate::CoreState>() {
                            state.runtime.revoke_overlay_capability(&label);
                        }
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
                handle_browser_download(&download_app, download_role_id.as_deref(), event)
            });
        if role_id.is_some() {
            if let Some(source) = overlay_document_start_script.as_deref() {
                builder = builder.initialization_script_for_all_frames(source);
            }
            #[cfg(target_os = "macos")]
            {
                // Match browser-like background tabs: keep hidden game pages throttled instead
                // of accepting WebKit's default full suspension. Role-less utility WebViews keep
                // the system default so imports are not delayed.
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
        let window_app = self.app.clone();
        let window_label = runtime_label("browser-data-clear", role_id);
        let window = self.create_window_bounded(role_id, move || {
            WindowBuilder::new(&window_app, window_label)
                .inner_size(1.0, 1.0)
                .visible(false)
                .build()
        })?;
        let webview = self
            .add_child_bounded(
                &window,
                self.webview_builder(
                    runtime_label("browser-data-clear-webview", role_id),
                    &paths,
                    None,
                )?,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
                role_id,
            )
            .inspect_err(|_| {
                let _ = window.close();
            })?;
        let lifecycle = match self.install_surface_lifecycle_tracker(&webview) {
            Ok(lifecycle) => lifecycle,
            Err(error) => {
                let _ = webview.close();
                let _ = window.close();
                return Err(error);
            }
        };
        let result = webview
            .clear_all_browsing_data()
            .map_err(RuntimeError::tauri);
        let cleanup = self
            .close_surface_and_wait(&webview, &lifecycle, role_id)
            .map(|_| ());
        let _ = window.close();
        result.and(cleanup)
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

        let (snapshot_window, snapshot_webview, snapshot_navigation, snapshot_lifecycle) =
            self.create_session_transfer_surface(role_id, &paths, None)?;
        let snapshot_result = (|| {
            let existing_backup = match backup_transaction_id {
                Some(transaction_id) => self
                    .state()?
                    .session_import_backups
                    .get(transaction_id)
                    .cloned(),
                None => None,
            };
            if backup_transaction_id.is_some() && existing_backup.is_none() {
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
                    snapshot_navigation.reset();
                    snapshot_webview
                        .navigate(launch.clone())
                        .map_err(RuntimeError::tauri)?;
                    snapshot_navigation.wait().map_err(|message| {
                        RuntimeError::new("SESSION_IMPORT_SNAPSHOT_LOAD_FAILED", message)
                    })?;
                    require_exact_webview_origin(&snapshot_webview, &origin)?;
                    read_local_storage_entries(&snapshot_webview)
                } else {
                    Ok(Vec::new())
                }?;
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
                return Err(rollback.err().unwrap_or(error));
            }
            Ok((cookie_backup, storage_backup, import_cookies))
        })();
        let snapshot_cleanup = self.close_hidden_surface(
            role_id,
            snapshot_window,
            snapshot_webview,
            &snapshot_lifecycle,
        );
        let (cookie_backup, storage_backup, import_cookies) =
            match (snapshot_result, snapshot_cleanup) {
                (Ok(result), Ok(())) => result,
                (Err(error), _) | (Ok(_), Err(error)) => return Err(error),
            };

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
            let (window, webview, navigation, lifecycle) =
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
            let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
            result.and(cleanup)
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
        let (window, webview, navigation, lifecycle) =
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
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        result.and(cleanup)
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
        let (window, webview, navigation, lifecycle) =
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
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        cleanup?;
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
        if let Ok(mut state) = self.state.lock() {
            state.session_import_backups.remove(transaction_id);
        }
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
    ) -> RuntimeResult<(
        Window,
        Webview,
        Arc<NavigationTracker>,
        Arc<SurfaceLifecycleTracker>,
    )> {
        let sequence = POPUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let suffix = format!("{role_id}:{sequence}");
        let window_app = self.app.clone();
        let window_label = runtime_label("session-transfer-window", &suffix);
        let window = self.create_window_bounded(role_id, move || {
            WindowBuilder::new(&window_app, window_label)
                .inner_size(1.0, 1.0)
                .visible(false)
                .build()
        })?;
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
        let webview = self
            .add_child_bounded(
                &window,
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
                role_id,
            )
            .inspect_err(|_| {
                let _ = window.close();
            })?;
        let lifecycle = match self.install_surface_lifecycle_tracker(&webview) {
            Ok(lifecycle) => lifecycle,
            Err(error) => {
                let _ = webview.close();
                let _ = window.close();
                return Err(error);
            }
        };
        if let Err(error) = install_platform_security_policy(&webview) {
            let _ = self.close_hidden_surface(role_id, window, webview, &lifecycle);
            return Err(error);
        }
        Ok((window, webview, navigation, lifecycle))
    }

    fn close_hidden_surface(
        &self,
        role_id: &str,
        window: Window,
        webview: Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
    ) -> RuntimeResult<()> {
        let surface_cleanup = self
            .close_surface_and_wait(&webview, lifecycle, role_id)
            .map(|_| ());
        let window_cleanup = window.close().map_err(RuntimeError::tauri);
        surface_cleanup.and(window_cleanup)
    }

    fn restore_role_session_cookies(
        &self,
        role_id: &str,
        paths: &SessionPaths,
        launch: &Url,
        backup: &[Cookie<'static>],
    ) -> RuntimeResult<()> {
        let (window, webview, _, lifecycle) =
            self.create_session_transfer_surface(role_id, paths, None)?;
        let result = restore_url_cookies(&webview, launch, backup);
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        result.and(cleanup)
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
        let (window, webview, navigation, lifecycle) =
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
        let cleanup = self.close_hidden_surface(role_id, window, webview, &lifecycle);
        result.and(cleanup)
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
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_LANE_POISONED",
                "The localStorage synchronization lifecycle lane is unavailable.",
            )
        })?;
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
            let (window, webview, navigation, lifecycle) =
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
            let cleanup = self.close_hidden_surface(source_role_id, window, webview, &lifecycle);
            match (result, cleanup) {
                (Ok(entries), Ok(())) => entries,
                (Err(error), _) | (Ok(_), Err(error)) => return Err(error),
            }
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
        generation: u64,
        sequence: u64,
        entries: Vec<(String, Option<String>)>,
    ) -> Result<(), String> {
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            "The localStorage synchronization lifecycle lane is unavailable.".to_owned()
        })?;
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
        if config.token != token || config.generation != generation {
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
        {
            let mut state = self.state().map_err(|error| error.message)?;
            let tab_id = state
                .role_tabs
                .get(&role_id)
                .cloned()
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let surface = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.roles.get_mut(&role_id))
                .filter(|surface| surface.webview.label() == webview_label)
                .ok_or_else(|| {
                    "Runtime role generation changed during localStorage synchronization."
                        .to_owned()
                })?;
            if !surface
                .local_storage_sync
                .as_ref()
                .is_some_and(|config| config.token == token && config.generation == generation)
            {
                return Err("The localStorage synchronization capability is stale.".to_owned());
            }
            if !accept_local_storage_sync_sequence(
                &mut surface.local_storage_sync_sequence,
                sequence,
            ) {
                return Ok(());
            }
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
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            "The localStorage synchronization lifecycle lane is unavailable.".to_owned()
        })?;
        let roles_by_id = roles
            .iter()
            .map(|role| (role.id.as_str(), role))
            .collect::<HashMap<_, _>>();
        let games_by_id = games
            .iter()
            .map(|game| (game.id.as_str(), game))
            .collect::<HashMap<_, _>>();
        let candidates = {
            let state = self.state().map_err(|error| error.message)?;
            state
                .tabs
                .values()
                .flat_map(|tab| tab.roles.iter())
                .map(|(role_id, surface)| {
                    let previous = surface.local_storage_sync.clone();
                    let next = roles_by_id.get(role_id.as_str()).and_then(|role| {
                        let game = games_by_id.get(role.game_id.as_str())?;
                        if game.local_storage_sync_keys.is_empty() {
                            return None;
                        }
                        let origin = checked_web_url(&role.launch_url)
                            .ok()?
                            .origin()
                            .ascii_serialization();
                        let token = previous
                            .as_ref()
                            .map(|config| config.token.clone())
                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        let generation = previous
                            .as_ref()
                            .map_or(1, |config| config.generation.saturating_add(1));
                        Some(LocalStorageRuntimeConfig {
                            dependent_role_ids: roles
                                .iter()
                                .filter(|candidate| {
                                    candidate.local_storage_source_role_id.as_deref()
                                        == Some(role.id.as_str())
                                })
                                .map(|candidate| candidate.id.clone())
                                .collect(),
                            generation,
                            keys: game.local_storage_sync_keys.clone(),
                            origin,
                            source_role_id: role.local_storage_source_role_id.clone(),
                            token,
                        })
                    });
                    (
                        role_id.clone(),
                        surface.webview.clone(),
                        surface.webview.label().to_owned(),
                        previous,
                        next,
                    )
                })
                .collect::<Vec<_>>()
        };
        let mut updates = Vec::with_capacity(candidates.len());
        for (role_id, webview, webview_label, previous, next) in candidates {
            let source_changed = previous
                .as_ref()
                .and_then(|config| config.source_role_id.clone())
                != next
                    .as_ref()
                    .and_then(|config| config.source_role_id.clone());
            let mut apply_scripts = Vec::new();
            let mut rollback_scripts = Vec::new();
            if let Some(config) = next.as_ref() {
                apply_scripts.push(
                    local_storage_sync_configure_script(config).map_err(|error| error.message)?,
                );
            } else if let Some(config) = previous.as_ref() {
                apply_scripts.push(
                    local_storage_sync_disable_script(&config.token)
                        .map_err(|error| error.message)?,
                );
            }
            if let Some(config) = previous.as_ref() {
                rollback_scripts.push(
                    local_storage_sync_configure_script(config).map_err(|error| error.message)?,
                );
            } else if let Some(config) = next.as_ref() {
                rollback_scripts.push(
                    local_storage_sync_disable_script(&config.token)
                        .map_err(|error| error.message)?,
                );
            }
            if source_changed
                && let Some(config) = next.as_ref()
                && let Some(source_role_id) = config.source_role_id.as_deref()
            {
                require_exact_local_storage_sync_origin(&webview, &config.origin)
                    .map_err(|error| error.message)?;
                let previous_entries = read_scoped_local_storage_entries(&webview, &config.keys)
                    .map_err(|error| error.message)?;
                let snapshot = self
                    .load_local_storage_sync_snapshot(source_role_id, &config.origin, &config.keys)
                    .map_err(|error| error.message)?;
                apply_scripts.push(
                    local_storage_sync_apply_script(&snapshot).map_err(|error| error.message)?,
                );
                rollback_scripts.push(
                    local_storage_sync_apply_script(&PersistedLocalStorageSyncSnapshot {
                        schema_version: 1,
                        source_role_id: role_id.clone(),
                        origin: config.origin.clone(),
                        entries: previous_entries,
                    })
                    .map_err(|error| error.message)?,
                );
            }
            updates.push(LocalStorageMetadataUpdate {
                apply_scripts,
                next,
                previous,
                role_id,
                rollback_scripts,
                webview,
                webview_label,
            });
        }
        if let Err(failure) = apply_reversible_fanout(
            &updates,
            |_, update| {
                evaluate_local_storage_metadata_scripts(&update.webview, &update.apply_scripts)
            },
            |_, update| {
                evaluate_local_storage_metadata_scripts(&update.webview, &update.rollback_scripts)
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "LOCAL_STORAGE_SYNC_METADATA_REFRESH_FAILED",
                "Refreshing localStorage synchronization metadata",
                &failure,
            )
            .message);
        }
        let mut state = self.state().map_err(|error| error.message)?;
        let stale = updates.iter().any(|update| {
            state
                .role_tabs
                .get(&update.role_id)
                .and_then(|tab_id| state.tabs.get(tab_id))
                .and_then(|tab| tab.roles.get(&update.role_id))
                .is_none_or(|surface| {
                    surface.webview.label() != update.webview_label
                        || surface.local_storage_sync != update.previous
                })
        });
        if stale {
            drop(state);
            let rollback_errors = rollback_reversible_fanout(&updates, |_, update| {
                evaluate_local_storage_metadata_scripts(&update.webview, &update.rollback_scripts)
            });
            if !rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(if rollback_errors.is_empty() {
                "Runtime roles changed before localStorage synchronization metadata could be committed."
                    .to_owned()
            } else {
                format!(
                    "Runtime roles changed before localStorage synchronization metadata could be committed. Compensation also failed: {}. Restart Rion Studio to recover safely.",
                    rollback_errors.join("; ")
                )
            });
        }
        for update in updates {
            let tab_id = state.role_tabs[&update.role_id].clone();
            let surface = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.roles.get_mut(&update.role_id))
                .expect("localStorage metadata commit prevalidated every runtime role");
            surface.local_storage_sync = update.next;
            surface.local_storage_sync_sequence = 0;
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
        let _local_storage_sync_guard = self.local_storage_sync_lane.lock().map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_LANE_POISONED",
                "The localStorage synchronization lifecycle lane is unavailable.",
            )
        })?;
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
        let window_app = self.app.clone();
        let window_title = native_runtime_window_title(title).to_owned();
        let bounds = target.bounds.clone();
        let physical_position = physical_window_position(bounds.x, bounds.y, target.scale_factor);
        let window = self.create_window_bounded(&target.window_id, move || {
            WindowBuilder::new(&window_app, window_label)
                .title(window_title)
                .inner_size(bounds.width.max(1) as f64, bounds.height.max(1) as f64)
                .min_inner_size(640.0, 480.0)
                .visible(false)
                .focused(false)
                .build()
        })?;
        window
            .set_position(PhysicalPosition::new(
                physical_position.0,
                physical_position.1,
            ))
            .map_err(RuntimeError::tauri)?;
        if let Err(error) = self.begin_surface_host_initialization(&window, &target.window_id) {
            let _ = window.close();
            return Err(error);
        }
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
        let tab_strip = match self.add_child_bounded(
            &window,
            WebviewBuilder::new(
                runtime_label("game-tab-strip", &host_id),
                WebviewUrl::App("runtime-tabs.html".into()),
            )
            .initialization_script(WINDOWS_RUNTIME_TAB_RESERVATION_SCRIPT),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(target.bounds.width.max(1) as f64, WINDOWS_TAB_STRIP_HEIGHT),
            &format!("{}:tab-strip", target.window_id),
        ) {
            Ok(tab_strip) => tab_strip,
            Err(error) => {
                let _ = window.close();
                return Err(error);
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

    fn with_native_creation_lane<T>(
        &self,
        window_id: &str,
        operation: impl FnOnce() -> RuntimeResult<T>,
    ) -> RuntimeResult<T> {
        let _global_permit = self.native_creation_slots.acquire()?;
        let lane = {
            let mut lanes = self.native_creation_lanes.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                    "The native surface creation coordinator is unavailable.",
                )
            })?;
            Arc::clone(
                lanes
                    .entry(window_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = lane.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_RUNTIME_CREATION_UNAVAILABLE",
                "The native surface creation lane is unavailable.",
            )
        })?;
        operation()
    }

    pub(crate) fn preview_tab_launch(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        source_id: &str,
        tab_type: &str,
    ) -> RuntimeResult<String> {
        let preview_started = Instant::now();
        self.mark_critical_activity();
        let key = format!("{tab_type}:{source_id}");
        if self.state()?.provisional_launches.contains_key(&key) {
            return Ok(key);
        }
        // An existing game window already owns a fully initialized native tab controller.
        // Reserving another tab must not wait behind an in-flight WKWebView/WebView2 creation:
        // that worker may itself be waiting for the UI thread to attach its controller.
        let existing_window = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| host.window.clone());
        let (window, host_created) = if let Some(window) = existing_window {
            (window, false)
        } else {
            self.with_native_creation_lane(&target.window_id, || {
                self.ensure_display_host(target, "Rion Studio")
            })?
        };
        let provisional_id = format!("provisional-{}", uuid::Uuid::new_v4());
        let placeholder_name = self
            .language
            .lock()
            .ok()
            .map(|language| match language.as_str() {
                "zh-TW" => "載入中…",
                "zh-CN" => "加载中…",
                "ja" => "読み込み中…",
                _ => "Loading…",
            })
            .unwrap_or("Loading…");
        let revision = self.presentation.next_revision();
        {
            let mut state = self.state()?;
            state.provisional_launches.insert(
                key.clone(),
                ProvisionalLaunch {
                    cancelled: false,
                    host_created,
                    id: provisional_id.clone(),
                    source_id: source_id.to_owned(),
                    tab_type: tab_type.to_owned(),
                    window_id: target.window_id.clone(),
                },
            );
        }
        let presentation = self
            .presentation
            .coordinator(&target.window_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        let (previous_tab_id, previous_surfaces) = {
            let mut selection = presentation.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            let previous_tab_id = selection.selected_tab_id.clone();
            let previous_surfaces = selection.surfaces(previous_tab_id.as_deref());
            selection.insert_tab(
                TabPresentation {
                    closable: true,
                    icon_data_url: None,
                    id: provisional_id.clone(),
                    phase: TabPresentationPhase::Reserved,
                    source_id: source_id.to_owned(),
                    tab_type: tab_type.to_owned(),
                    title: placeholder_name.to_owned(),
                    #[cfg(target_os = "macos")]
                    workspace_template: None,
                },
                revision,
                true,
            );
            (previous_tab_id, previous_surfaces)
        };
        if let Err(error) = self.reserve_native_tab(
            &target.window_id,
            &provisional_id,
            placeholder_name,
            tab_type,
            None,
            revision,
        ) {
            self.cancel_tab_launch_preview(&key);
            return Err(error);
        }
        // Both native reserve implementations activate the inserted item in the
        // same UI callback. Scheduling a second active-style callback only adds
        // event-loop work during a rapid launch burst.
        self.dispatch_native_presentation(
            target.window_id.clone(),
            Some(provisional_id),
            revision,
            "launch-preview",
            Instant::now(),
            window,
            previous_tab_id,
            previous_surfaces,
            Vec::new(),
            None,
            Some(true),
            false,
        );
        self.record_presentation_event(
            LogLevel::Debug,
            "tab.launch-preview-committed",
            "The launcher action committed its provisional presentation.",
            &target.window_id,
            self.state
                .lock()
                .ok()
                .and_then(|state| {
                    state
                        .provisional_launches
                        .get(&key)
                        .map(|launch| launch.id.clone())
                })
                .as_deref(),
            revision,
            "launch-preview",
            preview_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        );
        Ok(key)
    }

    pub(crate) fn cancel_tab_launch_preview(&self, key: &str) {
        let provisional = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.provisional_launches.remove(key));
        let Some(provisional) = provisional else {
            return;
        };
        let mut next_tab_id = None;
        if let Some(presentation) = self.presentation.existing(&provisional.window_id)
            && let Ok(mut selection) = presentation.lock()
        {
            let was_selected =
                selection.selected_tab_id.as_deref() == Some(provisional.id.as_str());
            let revision = self.presentation.next_revision();
            selection.remove_tab(&provisional.id, revision);
            if was_selected {
                next_tab_id = selection.tabs.last().map(|tab| tab.id.clone());
                selection.select(next_tab_id.clone(), revision);
            }
        }
        self.remove_native_tab_reservation(
            &provisional.window_id,
            &provisional.id,
            next_tab_id.as_deref(),
        );
        if let Some(tab_id) = next_tab_id {
            let _ = self.request_tab_presentation(&tab_id, false, "launch-preview-cancelled");
        }
        self.remove_empty_display_host(&provisional.window_id, provisional.host_created);
    }

    pub(crate) fn cancel_provisional_tab_launch(&self, tab_id: &str) -> bool {
        let provisional = self.state.lock().ok().and_then(|mut state| {
            state
                .provisional_launches
                .values_mut()
                .find(|launch| launch.id == tab_id)
                .map(|launch| {
                    launch.cancelled = true;
                    launch.clone()
                })
        });
        let Some(provisional) = provisional else {
            return false;
        };
        let mut next_tab_id = None;
        if let Some(presentation) = self.presentation.existing(&provisional.window_id)
            && let Ok(mut selection) = presentation.lock()
        {
            let was_selected =
                selection.selected_tab_id.as_deref() == Some(provisional.id.as_str());
            let revision = self.presentation.next_revision();
            selection.remove_tab(&provisional.id, revision);
            if was_selected {
                next_tab_id = selection.tabs.last().map(|tab| tab.id.clone());
                selection.select(next_tab_id.clone(), revision);
            }
        }
        self.remove_native_tab_reservation(
            &provisional.window_id,
            &provisional.id,
            next_tab_id.as_deref(),
        );
        if let Some(tab_id) = next_tab_id {
            let _ = self.request_tab_presentation(tab_id.as_str(), false, "launch-preview-closed");
        }
        true
    }

    fn take_tab_launch_preview(
        &self,
        window_id: &str,
        source_id: &str,
        tab_type: &str,
    ) -> RuntimeResult<Option<ProvisionalLaunch>> {
        let key = format!("{tab_type}:{source_id}");
        let mut state = self.state()?;
        let matches = state.provisional_launches.get(&key).is_some_and(|launch| {
            launch.window_id == window_id
                && launch.source_id == source_id
                && launch.tab_type == tab_type
        });
        if !matches {
            return Ok(None);
        }
        if state
            .provisional_launches
            .get(&key)
            .is_some_and(|launch| launch.cancelled)
        {
            return Err(RuntimeError::new(
                "LAUNCH_CANCELLED",
                "The provisional runtime tab was closed before native attachment began.",
            ));
        }
        Ok(state.provisional_launches.remove(&key).filter(|launch| {
            launch.window_id == window_id
                && launch.source_id == source_id
                && launch.tab_type == tab_type
        }))
    }

    fn create_tab(&self, tab: EmbeddedTabEffectRecord) -> RuntimeResult<()> {
        let launch_started = Instant::now();
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
            if tab.roles.iter().any(|role| {
                state
                    .close_coordinator
                    .closing_roles
                    .contains(&role.role.id)
                    || state
                        .close_coordinator
                        .quarantined_roles
                        .contains(&role.role.id)
                    || state.surface_registry.values().any(|surface| {
                        surface.role_id.as_deref() == Some(role.role.id.as_str())
                            && surface.phase.blocks_role_relaunch()
                    })
            }) {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "A closing or quarantined native surface still owns this role. Restart Rion Studio before reopening it.",
                ));
            }
        }
        // Surface creation uses the observer's last confirmed LocalStorage snapshot. A live
        // JavaScript refresh can take up to thirty seconds on an unresponsive source page and
        // must never delay tab reservation or native controller attachment.
        let target = tab.target.clone();
        let tab_type = if tab.workspace_id.is_some() {
            "workspace"
        } else {
            "role"
        };
        // Read the cancellation fence before waiting for any native window work. Closing a
        // provisional tab must abort the pending Core launch instead of creating a replacement
        // tab that the user already dismissed.
        let launch_preview =
            self.take_tab_launch_preview(&target.window_id, &tab.source_id, tab_type)?;
        let (window, native_host_created) = self
            .with_native_creation_lane(&target.window_id, || {
                self.ensure_display_host(&target, &tab.name)
            })?;
        let host_created = native_host_created
            || launch_preview
                .as_ref()
                .is_some_and(|preview| preview.host_created);
        let should_select = launch_preview.as_ref().is_none_or(|preview| {
            self.presentation
                .existing(&target.window_id)
                .and_then(|presentation| {
                    presentation.lock().ok().map(|selection| {
                        selection.selected_tab_id.as_deref() == Some(preview.id.as_str())
                    })
                })
                .unwrap_or(true)
        });
        let created_tab_id = tab.tab_id.clone();
        let reservation_revision = self.presentation.next_revision();
        {
            let mut state = self.state()?;
            state.tabs.insert(
                created_tab_id.clone(),
                RuntimeTab {
                    active_divider_resize: None,
                    audio_muted: false,
                    dividers: Vec::new(),
                    window_id: target.window_id.clone(),
                    roles: HashMap::new(),
                    workspace_id: tab.workspace_id.clone(),
                    workspace_appearance: tab.workspace_appearance.clone(),
                    #[cfg(target_os = "macos")]
                    workspace_template: tab.workspace_template.clone(),
                },
            );
            state
                .launch_phases
                .insert(created_tab_id.clone(), LaunchPhase::Attaching);
        }
        let presentation = self
            .presentation
            .coordinator(&target.window_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        let (previous_tab_id, previous_surfaces) = {
            let mut selection = presentation.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            let previous_tab_id = selection.selected_tab_id.clone();
            let previous_surfaces = selection.surfaces(previous_tab_id.as_deref());
            let presentation_tab = TabPresentation {
                closable: true,
                icon_data_url: None,
                id: created_tab_id.clone(),
                phase: TabPresentationPhase::Attaching,
                source_id: tab.source_id.clone(),
                tab_type: tab_type.to_owned(),
                title: tab.name.clone(),
                #[cfg(target_os = "macos")]
                workspace_template: tab.workspace_template.clone(),
            };
            if let Some(preview) = launch_preview.as_ref() {
                selection.replace_tab_id(&preview.id, presentation_tab, reservation_revision);
                if !should_select
                    && selection.selected_tab_id.as_deref() == Some(created_tab_id.as_str())
                {
                    selection.select(previous_tab_id.clone(), reservation_revision);
                }
            } else {
                selection.insert_tab(presentation_tab, reservation_revision, should_select);
            }
            if should_select {
                selection.select(Some(created_tab_id.clone()), reservation_revision);
            }
            (previous_tab_id, previous_surfaces)
        };
        self.record_runtime_stage(
            format!("tab-reserved:{}:{}", target.window_id, created_tab_id),
            "completed",
            launch_started,
        );
        self.record_runtime_stage(
            format!(
                "prewarm-{}:{}",
                if self.prewarm_state.load(Ordering::Acquire) == 2 {
                    "hit"
                } else {
                    "miss"
                },
                created_tab_id
            ),
            "completed",
            launch_started,
        );
        let active_tab_id =
            self.presentation
                .existing(&target.window_id)
                .and_then(|presentation| {
                    presentation
                        .lock()
                        .ok()
                        .and_then(|selection| selection.selected_tab_id.clone())
                });
        if let Some(preview) = launch_preview.as_ref() {
            let _ = self.replace_native_tab_reservation(
                &target.window_id,
                &preview.id,
                &created_tab_id,
                &tab.name,
                tab_type,
                tab.workspace_template.as_deref(),
                active_tab_id.as_deref(),
                reservation_revision,
            );
        } else {
            let _ = self.reserve_native_tab(
                &target.window_id,
                &created_tab_id,
                &tab.name,
                tab_type,
                tab.workspace_template.as_deref(),
                reservation_revision,
            );
        }
        self.dispatch_native_presentation(
            target.window_id.clone(),
            Some(created_tab_id.clone()),
            reservation_revision,
            "launch-reserved",
            Instant::now(),
            window.clone(),
            previous_tab_id,
            previous_surfaces,
            Vec::new(),
            None,
            Some(true),
            false,
        );
        self.wait_for_presentation_paint_barrier(&target.window_id, reservation_revision);
        let window_zoom_factor = self
            .state()?
            .display_hosts
            .get(&target.window_id)
            .map(|host| host.zoom_factor)
            .unwrap_or(1.0);
        let mut created_surfaces = Vec::new();
        let mut first_surface_recorded = false;
        let mut first_navigation_recorded = false;
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
            for role in &tab.roles {
                let role_id = role.role.id.clone();
                let generation = self.claim_surface_generation(&role_id)?;
                let sync_config =
                    role.local_storage_sync
                        .as_ref()
                        .map(|sync| LocalStorageRuntimeConfig {
                            dependent_role_ids: sync.dependent_role_ids.clone(),
                            generation: 1,
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
                let role_label =
                    runtime_label("game-role", &format!("{role_id}:generation-{generation}"));
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
                // The normalized role rectangle is sufficient for the first frame. Exact gap,
                // divider and adaptive-zoom layout runs after every role controller has attached,
                // so Core layout work can no longer delay the first native game viewport.
                let bounds = role_bounds_for_content(content_metrics, &role.rect);
                let base_zoom_factor = role.zoom_factor.clamp(0.25, 3.0);
                let webview = self.with_native_creation_lane(&target.window_id, || {
                    self.add_child_bounded(
                        &window,
                        builder,
                        LogicalPosition::new(bounds.x, bounds.y),
                        LogicalSize::new(bounds.width, bounds.height),
                        &role_id,
                    )
                })?;
                if !first_surface_recorded {
                    first_surface_recorded = true;
                    self.record_runtime_stage(
                        format!("controller-created:{}", tab.tab_id),
                        "completed",
                        launch_started,
                    );
                }
                // Controller visibility belongs to presentation, not native
                // setup or navigation readiness. Show the selected tab's blank
                // viewport immediately; a tab that was switched away from while
                // creation was in flight stays hidden.
                let selected_before_setup = self
                    .presentation
                    .existing(&target.window_id)
                    .and_then(|presentation| {
                        presentation.lock().ok().map(|presentation| {
                            presentation.selected_tab_id.as_deref() == Some(tab.tab_id.as_str())
                        })
                    })
                    .unwrap_or(false);
                let visibility_result = if selected_before_setup {
                    webview.show()
                } else {
                    webview.hide()
                };
                if let Err(error) = visibility_result {
                    return Err(RuntimeError::tauri(error));
                }
                self.record_runtime_stage(
                    format!("controller-presented:{role_id}"),
                    "completed",
                    launch_started,
                );
                created_surfaces.push((role_id.clone(), webview.clone(), None, None));
                let setup_started = Instant::now();
                let setup_stage = format!("native-role-setup:{role_id}");
                self.record_runtime_stage(&setup_stage, "started", setup_started);
                let lifecycle = match self.setup_role_surface(&webview, &role_id, generation) {
                    Ok(lifecycle) => {
                        self.record_runtime_stage(&setup_stage, "completed", setup_started);
                        self.record_runtime_stage(
                            format!("native-setup-completed:{role_id}"),
                            "completed",
                            launch_started,
                        );
                        lifecycle
                    }
                    Err(error) => {
                        self.record_runtime_stage(&setup_stage, "failed", setup_started);
                        return Err(error);
                    }
                };
                created_surfaces
                    .last_mut()
                    .expect("role surface was just recorded")
                    .2 = Some(Arc::clone(&lifecycle));
                let surface_instance_id = self.register_managed_surface(
                    &webview,
                    &lifecycle,
                    ManagedSurfaceKind::Role,
                    ManagedSurfacePhase::Live,
                    Some(&role_id),
                    Some(&tab.tab_id),
                    &target.window_id,
                    generation,
                )?;
                created_surfaces
                    .last_mut()
                    .expect("role surface was just registered")
                    .3 = Some(surface_instance_id.clone());
                {
                    let mut state = self.state()?;
                    state.role_tabs.insert(role_id.clone(), tab.tab_id.clone());
                    let runtime_tab = state.tabs.get_mut(&tab.tab_id).ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                            "The provisional runtime tab disappeared before attachment completed.",
                        )
                    })?;
                    runtime_tab.roles.insert(
                        role_id.clone(),
                        RoleSurface {
                            current_url: None,
                            generation,
                            high_refresh_rate_status: configure_platform_high_refresh_rate(
                                &webview, false,
                            ),
                            lifecycle: Arc::clone(&lifecycle),
                            local_storage_sync: sync_config,
                            local_storage_sync_sequence: 0,
                            navigation: Arc::clone(&navigation),
                            rect: role.rect.clone(),
                            surface_instance_id: surface_instance_id.clone(),
                            webview: webview.clone(),
                            zoom_factor: base_zoom_factor,
                            zoom_mode: role.zoom_mode.clone(),
                        },
                    );
                }
                let selected = self
                    .presentation
                    .existing(&target.window_id)
                    .and_then(|presentation| {
                        presentation.lock().ok().map(|mut presentation| {
                            let bound = presentation.bind_surface(
                                &tab.tab_id,
                                SurfacePresentationBinding {
                                    generation,
                                    instance_id: surface_instance_id.clone(),
                                    webview: webview.clone(),
                                },
                            );
                            (
                                bound,
                                presentation.selected_tab_id.as_deref()
                                    == Some(tab.tab_id.as_str()),
                            )
                        })
                    })
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                            "The runtime tab presentation disappeared before surface binding.",
                        )
                    })?;
                if !selected.0 {
                    return Err(RuntimeError::new(
                        "SYSTEM_RUNTIME_TAB_RESERVATION_STALE",
                        "The runtime tab was removed before its native surface could bind.",
                    ));
                }
                self.record_runtime_stage(
                    format!("surface-bound:{}:{role_id}", tab.tab_id),
                    "completed",
                    launch_started,
                );
                if selected.1 {
                    let _ = self.request_tab_presentation(&tab.tab_id, false, "surface-attached");
                } else {
                    webview.hide().map_err(RuntimeError::tauri)?;
                }
                webview
                    .set_zoom(effective_zoom_factor(base_zoom_factor, window_zoom_factor))
                    .map_err(RuntimeError::tauri)?;
                let url = checked_web_url(&role.role.launch_url)?;
                let navigation_allowed = {
                    let state = self.state()?;
                    !state.close_coordinator.closing_roles.contains(&role_id)
                        && !state.close_coordinator.quarantined_roles.contains(&role_id)
                        && state
                            .tabs
                            .get(&tab.tab_id)
                            .is_some_and(|runtime_tab| runtime_tab.roles.contains_key(&role_id))
                };
                if !navigation_allowed {
                    return Err(RuntimeError::new(
                        "LAUNCH_CANCELLED",
                        "The provisional runtime tab closed before game navigation began.",
                    ));
                }
                let controlled_label = webview.label().to_owned();
                self.begin_controlled_navigation(&controlled_label)?;
                navigation.reset();
                if let Ok(mut state) = self.state()
                    && let Some(role_surface) = state
                        .tabs
                        .get_mut(&tab.tab_id)
                        .and_then(|runtime_tab| runtime_tab.roles.get_mut(&role_id))
                {
                    role_surface.current_url = Some(url.clone());
                }
                webview.navigate(url).map_err(RuntimeError::tauri)?;
                if !first_navigation_recorded {
                    first_navigation_recorded = true;
                    self.record_runtime_stage(
                        format!("navigation-requested:{}", tab.tab_id),
                        "completed",
                        launch_started,
                    );
                }
            }
            self.record_runtime_stage(
                format!("all-surfaces-attached:{}", tab.tab_id),
                "completed",
                launch_started,
            );
            let (resolved_role_bounds, _resolved_dividers) = self.resolve_runtime_layout(
                content_metrics,
                role_inputs,
                tab.workspace_appearance.gap,
            )?;
            for role in &tab.roles {
                let Some(bounds) = resolved_role_bounds.get(&role.role.id).copied() else {
                    continue;
                };
                let (webview, current_zoom_factor, adaptive) = {
                    let state = self.state()?;
                    let surface = state
                        .tabs
                        .get(&tab.tab_id)
                        .and_then(|runtime_tab| runtime_tab.roles.get(&role.role.id))
                        .ok_or_else(|| {
                            RuntimeError::new(
                                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                                "Runtime role was not found after native attachment.",
                            )
                        })?;
                    (
                        surface.webview.clone(),
                        surface.zoom_factor,
                        surface.zoom_mode == "adaptive",
                    )
                };
                let base_zoom_factor = if adaptive {
                    self.adaptive_zoom_factor(bounds.width, Some(current_zoom_factor))?
                } else {
                    current_zoom_factor
                };
                if adaptive
                    && let Ok(mut state) = self.state()
                    && let Some(surface) = state
                        .tabs
                        .get_mut(&tab.tab_id)
                        .and_then(|runtime_tab| runtime_tab.roles.get_mut(&role.role.id))
                {
                    surface.zoom_factor = base_zoom_factor;
                }
                webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .and_then(|()| webview.set_size(LogicalSize::new(bounds.width, bounds.height)))
                    .and_then(|()| {
                        webview
                            .set_zoom(effective_zoom_factor(base_zoom_factor, window_zoom_factor))
                    })
                    .map_err(RuntimeError::tauri)?;
            }
            self.finish_surface_host_initialization(&window, host_created, &target.window_id)?;
            self.set_launch_phase(&tab.tab_id, LaunchPhase::Navigating);
            Ok(())
        })();
        if result.is_err() {
            if let Some(presentation) = self.presentation.existing(&target.window_id)
                && let Ok(mut presentation) = presentation.lock()
            {
                presentation.update_phase(&created_tab_id, TabPresentationPhase::Failed);
            }
            let controlled_labels = created_surfaces
                .iter()
                .map(|(_, webview, _, _)| webview.label().to_owned())
                .collect::<Vec<_>>();
            self.finish_controlled_navigations(&controlled_labels);
            for (surface_id, webview, lifecycle, instance_id) in created_surfaces {
                if let Some(instance_id) = instance_id {
                    let _ = self.close_managed_surface_and_wait(&instance_id, &surface_id);
                } else if let Some(lifecycle) = lifecycle {
                    let _ = self.close_surface_and_wait(&webview, &lifecycle, &surface_id);
                } else {
                    let _ = webview.close();
                }
            }
            if let Ok(mut state) = self.state.lock() {
                state.tabs.remove(&created_tab_id);
                state.launch_phases.remove(&created_tab_id);
                state
                    .role_tabs
                    .retain(|_, tab_id| tab_id != &created_tab_id);
            }
            let mut next_tab_id = None;
            if let Some(presentation) = self.presentation.existing(&target.window_id)
                && let Ok(mut selection) = presentation.lock()
            {
                let was_selected =
                    selection.selected_tab_id.as_deref() == Some(created_tab_id.as_str());
                let revision = self.presentation.next_revision();
                selection.remove_tab(&created_tab_id, revision);
                if was_selected {
                    let successor = selection.tabs.last().map(|tab| tab.id.clone());
                    selection.select(successor, revision);
                }
                next_tab_id = selection.selected_tab_id.clone();
            }
            if let Some(next_tab_id) = next_tab_id.as_deref() {
                let _ = self.request_tab_presentation(next_tab_id, false, "launch-failed");
            }
            self.remove_native_tab_reservation(
                &target.window_id,
                &created_tab_id,
                next_tab_id.as_deref(),
            );
            self.remove_empty_display_host(&target.window_id, host_created);
        } else {
            let remains_selected =
                self.presentation
                    .existing(&target.window_id)
                    .is_some_and(|presentation| {
                        presentation.lock().ok().is_some_and(|window| {
                            window.selected_tab_id.as_deref() == Some(created_tab_id.as_str())
                        })
                    });
            if remains_selected {
                let _ = self.request_tab_presentation(&created_tab_id, false, "surface-attached");
            }
        }
        result
    }

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
                navigation
                    .wait()
                    .map_err(|message| RuntimeError::new("TAURI_NAVIGATION_FAILED", message))?;
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

    fn apply_runtime(
        &self,
        snapshot: BrowserRuntimeSnapshot,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: &[String],
        focus_window_ids: &[String],
        focus_tab_id: Option<&str>,
        _presentation_revision: u64,
    ) -> RuntimeResult<()> {
        struct TabUpdate {
            window_id: String,
            moved: bool,
            source_window_id: String,
            surfaces: Vec<Webview>,
            tab_id: String,
        }
        struct HostUpdate {
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
            let (_, created) = self.ensure_display_host(target, title)?;
            Some((target.window_id.clone(), created))
        } else {
            None
        };

        let presentation_windows = {
            let mut windows = HashMap::new();
            for runtime_window in &snapshot.windows {
                let presentation = self
                    .presentation
                    .coordinator(&runtime_window.window_id)
                    .map_err(|message| {
                        RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
                    })?;
                let mut window = presentation.lock().map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The runtime tab presentation coordinator is unavailable.",
                    )
                })?;
                for snapshot_tab in snapshot
                    .tabs
                    .iter()
                    .filter(|tab| tab.window_id == runtime_window.window_id)
                {
                    window.update_metadata(
                        &snapshot_tab.id,
                        &snapshot_tab.source_id,
                        &snapshot_tab.tab_type,
                        &snapshot_tab.name,
                    );
                }
                // Core may persist ordering and metadata, but it must never delete a newer
                // provisional/closing presentation entry or overwrite the local selection.
                window.reorder_known_tabs(&runtime_window.tab_ids);
                let local_ids = window.tab_ids();
                window
                    .aliases
                    .retain(|_, target| local_ids.contains(target));
                windows.insert(runtime_window.window_id.clone(), window.clone());
            }
            windows
        };
        // apply_runtime is a native topology projection and must not synchronously call back
        // into AppCore while a core effect is awaiting it. Restore callers already omit focus
        // requests, and titles fall back to the active snapshot tab below.
        let game_window_names = HashMap::<String, String>::new();
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
                        window_id: plan.window_id.clone(),
                        moved: plan.moved,
                        source_window_id: runtime_tab.window_id.clone(),
                        surfaces,
                        tab_id: plan.tab_id.clone(),
                    })
                })
                .collect::<Vec<_>>()
        };

        let presentation_reconcile_windows = tab_updates
            .iter()
            .filter(|update| update.moved)
            .flat_map(|update| [update.source_window_id.clone(), update.window_id.clone()])
            .collect::<HashSet<_>>();

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

        let (obsolete_window_ids, moved_registry_surfaces) = {
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
                for surface in state.surface_registry.values_mut() {
                    if surface.tab_id.as_deref() == Some(update.tab_id.as_str()) {
                        surface.window_id = update.window_id.clone();
                    }
                }
            }
            let moved_registry_surfaces = state
                .surface_registry
                .values()
                .filter(|surface| {
                    tab_updates.iter().any(|update| {
                        update.moved && surface.tab_id.as_deref() == Some(update.tab_id.as_str())
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            let obsolete_window_ids = state
                .display_hosts
                .keys()
                .filter(|window_id| !desired_windows.contains(window_id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            (obsolete_window_ids, moved_registry_surfaces)
        };
        for surface in &moved_registry_surfaces {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.moved",
                "Native surface ownership moved to another window.",
                surface,
            );
        }

        if let Some(target) = target.as_ref()
            && let Some(window) = self.window_for_id(&target.window_id)
        {
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            if runtime_target_requires_placement_reapply(&target.presentation, fullscreen) {
                if fullscreen {
                    window.set_fullscreen(false).map_err(RuntimeError::tauri)?;
                }
                if window.is_maximized().unwrap_or(false) {
                    window.unmaximize().map_err(RuntimeError::tauri)?;
                }
                window
                    .set_position(LogicalPosition::new(
                        target.bounds.x as f64,
                        target.bounds.y as f64,
                    ))
                    .map_err(RuntimeError::tauri)?;
                window
                    .set_size(LogicalSize::new(
                        target.bounds.width.max(1) as f64,
                        target.bounds.height.max(1) as f64,
                    ))
                    .map_err(RuntimeError::tauri)?;
            }
        }

        for update in &tab_updates {
            if update.moved
                || target
                    .as_ref()
                    .is_some_and(|target| target.window_id == update.window_id)
            {
                self.layout_runtime_tab(&update.tab_id)?;
            }
        }

        for window_id in &presentation_reconcile_windows {
            self.reconcile_window_presentation(window_id, "topology-reconciled")?;
        }

        if let Some((window_id, created)) = &ensured_target_host
            && *created
            && let Some(window) = self.window_for_id(window_id)
        {
            self.finish_surface_host_initialization(&window, true, window_id)?;
        }

        let host_updates = {
            let state = self.state()?;
            state
                .display_hosts
                .values()
                .map(|host| {
                    let window_id = &host.target.window_id;
                    let presentation_window = presentation_windows.get(window_id);
                    let active_tab = presentation_window
                        .and_then(|selection| selection.selected_tab_id.as_deref())
                        .filter(|tab_id| {
                            state.tabs.get(*tab_id).is_some_and(|tab| {
                                tab.window_id == *window_id
                                    && !state.optimistic_closed_tabs.contains(*tab_id)
                            })
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
                    HostUpdate {
                        presentation: host.target.presentation.clone(),
                        reveal: reveal_window_ids.contains(window_id),
                        retain_visibility: presentation_window
                            .is_some_and(|presentation| presentation.host_visibility),
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
                update.window.show().map_err(RuntimeError::tauri)?;
            } else if !visible && currently_visible {
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
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn sync_native_tab_metadata(&self, snapshot: &BrowserRuntimeSnapshot) {
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
        let selected_tabs = self.presentation.selected_tabs();
        let updates = self
            .state
            .lock()
            .ok()
            .map(|state| {
                snapshot
                    .tabs
                    .iter()
                    .filter(|tab| !tab.hidden && !state.optimistic_closed_tabs.contains(&tab.id))
                    .filter_map(|tab| {
                        let live = state.tabs.get(&tab.id)?;
                        let presented = self.presentation.tab(&live.window_id, &tab.id)?;
                        let controller = state
                            .display_hosts
                            .get(&live.window_id)?
                            .tabs_controller
                            .clone();
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
                        let icon_data_url = presented.icon_data_url.clone().or_else(|| {
                            tab.role_ids.first().and_then(|role_id| {
                                role_games
                                    .get(role_id.as_str())
                                    .and_then(|game_id| game_icons.get(*game_id))
                                    .map(|value| (*value).to_owned())
                            })
                        });
                        let _presentation_identity =
                            (presented.source_id.as_str(), presented.phase.as_str());
                        Some((
                            controller,
                            !presented.closable,
                            crate::runtime_tabs_macos::MacRuntimeTabState {
                                active: selected_tabs
                                    .get(&live.window_id)
                                    .is_some_and(|selected| selected == &tab.id),
                                audio_muted: live.audio_muted,
                                audible: runtime_tab_is_audible(&state, live),
                                icon_data_url,
                                id: tab.id.clone(),
                                name: presented.title,
                                tooltip,
                                tab_type: presented.tab_type,
                                workspace_template: presented
                                    .workspace_template
                                    .or_else(|| live.workspace_template.clone()),
                            },
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (controller, presentation_hides_close, tab) in updates {
            let _ = controller.update_metadata(
                tab,
                preferences.always_show_toolbar_in_full_screen,
                preferences.always_hide_tab_close_button || presentation_hides_close,
                &language,
            );
        }
    }

    #[cfg(windows)]
    fn sync_windows_tab_metadata(&self, snapshot: &BrowserRuntimeSnapshot) {
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
        let role_names = roles
            .iter()
            .map(|role| (role.id.as_str(), role.name.as_str()))
            .collect::<HashMap<_, _>>();
        let (muted_label, playing_label, close_label) = match language.as_str() {
            "zh-TW" => ("分頁已靜音", "正在播放聲音", "停止並關閉分頁"),
            "zh-CN" => ("标签页已静音", "正在播放声音", "停止并关闭标签页"),
            "ja" => ("タブはミュート中", "音声を再生中", "停止してタブを閉じる"),
            _ => ("Tab muted", "Playing audio", "Stop and close tab"),
        };
        let updates = self
            .state
            .lock()
            .ok()
            .map(|state| {
                snapshot
                    .tabs
                    .iter()
                    .filter(|tab| {
                        !tab.hidden && !state.optimistic_closed_tabs.contains(&tab.id)
                    })
                    .filter_map(|tab| {
                        let live = state.tabs.get(&tab.id)?;
                        let presented = self.presentation.tab(&live.window_id, &tab.id)?;
                        let tab_strip = state.display_hosts.get(&live.window_id)?.tab_strip.clone();
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
                        let icon_data_url = presented.icon_data_url.clone().or_else(|| {
                            tab.role_ids
                                .first()
                                .and_then(|role_id| icons.get(role_id.as_str()))
                                .cloned()
                        });
                        Some((
                            tab_strip,
                            json!({
                                "id": tab.id,
                                "name": presented.title,
                                "type": presented.tab_type,
                                "sourceId": presented.source_id,
                                "phase": presented.phase.as_str(),
                                "tooltip": tooltip,
                                "iconDataUrl": icon_data_url,
                                "audible": runtime_tab_is_audible(&state, live),
                                "audioMuted": live.audio_muted,
                                "hideCloseButton": always_hide_tab_close_button || !presented.closable,
                                "mutedLabel": muted_label,
                                "playingLabel": playing_label,
                                "closeLabel": close_label,
                            }),
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let batches = updates.into_iter().fold(
            HashMap::<String, (Webview, Vec<Value>)>::new(),
            |mut batches, (webview, metadata)| {
                batches
                    .entry(webview.label().to_owned())
                    .or_insert_with(|| (webview.clone(), Vec::new()))
                    .1
                    .push(metadata);
                batches
            },
        );
        for (_, (webview, metadata)) in batches {
            let Ok(metadata) = serde_json::to_string(&metadata) else {
                continue;
            };
            let _ = webview.eval(format!(
                "window.__rionUpdateRuntimeTabMetadataBatch?.({metadata});"
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

    fn close_surface_and_wait(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        role_id: &str,
    ) -> RuntimeResult<SurfaceCloseOutcome> {
        let label = webview.label().to_owned();
        {
            let mut state = self.state()?;
            if !state
                .close_coordinator
                .closing_webviews
                .insert(label.clone())
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_ALREADY_CLOSING",
                    "The System WebView surface is already closing.",
                ));
            }
        }
        let result = (|| -> RuntimeResult<SurfaceCloseOutcome> {
            let platform = if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "other"
            };
            let deadline = Instant::now() + SURFACE_RECLAMATION_TIMEOUT;
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.blank-requested",
                "Native blank isolation was requested.",
                &label,
            );
            let quiesce_result = if lifecycle.native_surface_is_released() {
                lifecycle.mark_isolated();
                Ok(())
            } else {
                quiesce_platform_surface(webview, lifecycle)
            };
            let first_isolation =
                quiesce_result.is_ok() && lifecycle.wait_for_isolation(SURFACE_ISOLATION_TIMEOUT);
            if !first_isolation && quiesce_result.is_ok() {
                self.record_surface_stage_by_label(
                    LogLevel::Warn,
                    "surface.blank-retry",
                    "The native blank isolation request is being retried once.",
                    &label,
                );
                let _ = quiesce_platform_surface(webview, lifecycle);
            }
            let isolated = first_isolation
                || lifecycle.native_surface_is_released()
                || lifecycle.wait_for_isolation(deadline.saturating_duration_since(Instant::now()));
            if !isolated {
                self.record_surface_stage_by_label(
                    LogLevel::Error,
                    "surface.quiesce-unverified",
                    "Native surface isolation could not be verified.",
                    &label,
                );
                let quiesce_error = quiesce_result.err().map(|error| error.message);
                let message = "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.".to_owned();
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                        "failureKind": "native-isolation-timeout",
                        "message": message,
                        "roleId": role_id,
                        "webviewLabel": label,
                        "quiesceError": quiesce_error,
                        "isolationWaitMs": SURFACE_RECLAMATION_TIMEOUT.as_millis()
                    }),
                );
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    message,
                ));
            }
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.blank-finished",
                "Native blank isolation was confirmed for the exact surface.",
                &label,
            );
            self.record_surface_stage_by_label(
                LogLevel::Debug,
                "surface.controller-close-queued",
                "The isolated native controller close was queued.",
                &label,
            );
            let close_error = webview.close().err().map(|error| error.to_string());
            if close_error.is_some() {
                self.record_surface_stage_by_label(
                    LogLevel::Warn,
                    "surface.controller-close-deferred",
                    "The isolated native controller will remain in background cleanup.",
                    &label,
                );
            }
            let released = lifecycle.wait_for_controller_release(platform, Duration::ZERO);
            Ok(SurfaceCloseOutcome { isolated, released })
        })();
        if result.is_ok() {
            self.revoke_overlay_capability(&label);
        }
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_webviews.remove(&label);
        }
        result
    }

    fn close_managed_surface_and_wait(
        &self,
        instance_id: &str,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        let surface = self.managed_surface(instance_id)?;
        match surface.phase {
            ManagedSurfacePhase::Isolated
            | ManagedSurfacePhase::Releasing
            | ManagedSurfacePhase::Released => return Ok(()),
            ManagedSurfacePhase::CloseRequested | ManagedSurfacePhase::Isolating => {
                return self.wait_for_managed_surface_isolation(instance_id, &surface);
            }
            ManagedSurfacePhase::Live
            | ManagedSurfacePhase::Provisional
            | ManagedSurfacePhase::Quarantined
            | ManagedSurfacePhase::Retired => {}
        }
        let native_lifecycle_guard = surface.native_lifecycle_lane.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_LIFECYCLE_UNAVAILABLE",
                "The native surface lifecycle lane is unavailable.",
            )
        })?;
        let (surface, owns_close) = {
            let mut state = self.state()?;
            let surface = state.surface_registry.get_mut(instance_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The native surface registry entry is missing.",
                )
            })?;
            let owns_close = match surface.phase {
                ManagedSurfacePhase::Isolated
                | ManagedSurfacePhase::Releasing
                | ManagedSurfacePhase::Released => return Ok(()),
                ManagedSurfacePhase::CloseRequested | ManagedSurfacePhase::Isolating => false,
                ManagedSurfacePhase::Live
                | ManagedSurfacePhase::Provisional
                | ManagedSurfacePhase::Quarantined
                | ManagedSurfacePhase::Retired => {
                    surface.phase = ManagedSurfacePhase::CloseRequested;
                    surface.close_started_at = Some(Instant::now());
                    true
                }
            };
            (surface.clone(), owns_close)
        };
        if !owns_close {
            drop(native_lifecycle_guard);
            return self.wait_for_managed_surface_isolation(instance_id, &surface);
        }
        self.record_surface_event(
            LogLevel::Debug,
            "surface.phase",
            "Native surface phase changed.",
            &surface,
        );
        self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::Isolating)?;
        self.record_surface_event(
            LogLevel::Info,
            "surface.close-requested",
            "Native surface close requested.",
            &surface,
        );
        let result =
            self.close_surface_and_wait(&surface.webview, &surface.lifecycle, lifecycle_id);
        match result {
            Ok(outcome) => {
                self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::Isolated)?;
                if outcome.released {
                    self.remove_managed_surface(instance_id)?;
                } else {
                    let retired = self.retire_managed_surface(instance_id)?;
                    self.schedule_surface_reclamation(retired, true);
                }
                Ok(())
            }
            Err(error) => {
                if let Ok(mut state) = self.state.lock() {
                    if let Some(current) = state.surface_registry.get_mut(instance_id) {
                        current.phase = ManagedSurfacePhase::Quarantined;
                    }
                    if let Some(role_id) = surface.role_id.as_ref() {
                        state
                            .close_coordinator
                            .quarantined_roles
                            .insert(role_id.clone());
                    }
                }
                self.record_surface_event(
                    LogLevel::Error,
                    "surface.close-unverified",
                    "Native surface close could not be verified.",
                    &surface,
                );
                Err(RuntimeError::new(error.code, error.message))
            }
        }
    }

    fn wait_for_managed_surface_isolation(
        &self,
        instance_id: &str,
        surface: &ManagedSurface,
    ) -> RuntimeResult<()> {
        let deadline = surface
            .close_started_at
            .unwrap_or_else(Instant::now)
            .checked_add(SURFACE_RECLAMATION_TIMEOUT)
            .unwrap_or_else(Instant::now);
        if surface
            .lifecycle
            .wait_for_isolation(deadline.saturating_duration_since(Instant::now()))
        {
            return Ok(());
        }
        let phase = self
            .state()?
            .surface_registry
            .get(instance_id)
            .map(|surface| surface.phase);
        if phase.is_none()
            || matches!(
                phase,
                Some(
                    ManagedSurfacePhase::Isolated
                        | ManagedSurfacePhase::Releasing
                        | ManagedSurfacePhase::Released
                )
            )
        {
            return Ok(());
        }
        Err(RuntimeError::new(
            "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
            "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.",
        ))
    }

    fn schedule_surface_reclamation(&self, surface: ManagedSurface, isolated: bool) {
        let Some(sender) = self.effect_sender.get().cloned() else {
            return;
        };
        let app = self.app.clone();
        let instance_id = surface.instance_id.clone();
        let lifecycle = Arc::clone(&surface.lifecycle);
        let label = surface.webview.label().to_owned();
        let spawn = std::thread::Builder::new()
            .name(format!("rion-surface-release-{instance_id}"))
            .spawn(move || {
                // Wry unregisters asynchronously. Observe it once after the close command has
                // crossed an event-loop turn; never poll AppKit or synchronously dispatch to the
                // main queue from a reclamation worker.
                std::thread::sleep(Duration::from_millis(250));
                let released = app.get_webview(&label).is_none();
                if released {
                    lifecycle.mark_controller_released();
                }
                let _ = sender.send(SystemRuntimeWork::FinalizeSurfaceRelease {
                    instance_id,
                    isolated,
                    released,
                });
            });
        if let Err(error) = spawn {
            eprintln!(
                "System WebView lifecycle: stage=surface-release-worker status=failed error={error}"
            );
        }
    }

    fn finalize_surface_release(&self, instance_id: &str, isolated: bool, released: bool) {
        let Ok(surface) = self.managed_surface(instance_id) else {
            return;
        };
        if released {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.tauri-unregistered",
                "Tauri unregistered the retired native surface.",
                &surface,
            );
            let _ = self.remove_managed_surface(instance_id);
            return;
        }
        if isolated {
            let _ = self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::Releasing);
            self.record_surface_event(
                LogLevel::Warn,
                "surface.release-deferred",
                "Native surface is isolated but its resource release remains pending.",
                &surface,
            );
            return;
        }
        let _ = self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::Quarantined);
        self.record_surface_event(
            LogLevel::Error,
            "surface.quarantine-persisted",
            "Native surface isolation remained unverified after background retries.",
            &surface,
        );
        let _ = self.app.emit(
            "rion://shell-error",
            json!({
                "code": "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                "failureKind": "native-isolation-retry-exhausted",
                "message": "Rion Studio still cannot verify that the native game page stopped. Keep this tab closed and restart Rion Studio before reopening the role.",
                "roleId": surface.role_id,
                "webviewLabel": surface.webview.label()
            }),
        );
    }

    fn close_popup_and_wait(&self, label: &str, role_id: &str) -> RuntimeResult<()> {
        let instance_id = self
            .state()?
            .surface_registry
            .values()
            .find(|surface| {
                surface.kind == ManagedSurfaceKind::Popup
                    && surface.role_id.as_deref() == Some(role_id)
                    && surface.webview.label() == label
            })
            .map(|surface| surface.instance_id.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_REGISTRY_MISSING",
                    "The popup native surface registry entry is missing.",
                )
            })?;
        self.close_managed_surface_and_wait(&instance_id, role_id)
    }

    fn close_managed_divider(&self, instance_id: &str) -> RuntimeResult<()> {
        let surface = self.managed_surface(instance_id)?;
        if surface.kind != ManagedSurfaceKind::Divider {
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_REGISTRY_MISMATCH",
                "The native surface is not a workspace divider.",
            ));
        }
        self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::CloseRequested)?;
        self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::Isolating)?;
        let _ = surface.webview.close();
        self.set_managed_surface_phase(instance_id, ManagedSurfacePhase::Isolated)?;
        let retired = self.retire_managed_surface(instance_id)?;
        self.schedule_surface_reclamation(retired, true);
        Ok(())
    }

    fn add_child_bounded(
        &self,
        window: &Window,
        builder: WebviewBuilder<tauri::Wry>,
        position: LogicalPosition<f64>,
        size: LogicalSize<f64>,
        lifecycle_id: &str,
    ) -> RuntimeResult<Webview> {
        self.health.require_healthy()?;
        let restore_parent = self.prepare_surface_parent_for_creation(window, lifecycle_id)?;
        let stage = format!("native-webview-create:{lifecycle_id}");
        let started = Instant::now();
        self.record_runtime_stage(&stage, "started", started);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let create_window = window.clone();
        std::thread::Builder::new()
            .name("rion-webview-create".to_owned())
            .spawn(move || {
                let result = create_window.add_child(builder, position, size);
                if let Err(mpsc::SendError(Ok(stale_webview))) = sender.send(result) {
                    // The bounded caller timed out. A late native callback must never
                    // become the active surface for a newer lifecycle generation.
                    let _ = stale_webview.close();
                }
            })
            .map_err(|error| {
                RuntimeError::new("SYSTEM_WEBVIEW_CREATE_WORKER_FAILED", error.to_string())
            })?;
        match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
            Ok(result) => {
                self.record_runtime_stage(
                    stage,
                    if result.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    },
                    started,
                );
                let release =
                    self.finish_surface_host_initialization(window, restore_parent, lifecycle_id);
                match (result, release) {
                    (Ok(webview), Ok(())) => Ok(webview),
                    (Ok(webview), Err(error)) => {
                        let _ = webview.close();
                        Err(error)
                    }
                    (Err(error), Ok(())) => Err(RuntimeError::tauri(error)),
                    (Err(_), Err(error)) => Err(error),
                }
            }
            Err(error) => {
                self.record_runtime_stage(stage, "failed", started);
                self.health.mark_unhealthy();
                let failure_kind = match error {
                    mpsc::RecvTimeoutError::Timeout => "creation-timeout",
                    mpsc::RecvTimeoutError::Disconnected => "creation-worker-disconnected",
                };
                let message = format!(
                    "The System WebView surface {lifecycle_id} did not finish native creation within {}ms. Restart Rion Studio before launching another browser role.",
                    PLATFORM_CALLBACK_TIMEOUT.as_millis()
                );
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "SYSTEM_WEBVIEW_CREATION_STALLED",
                        "failureKind": failure_kind,
                        "message": message,
                        "surfaceId": lifecycle_id,
                        "windowId": window.label()
                    }),
                );
                Err(RuntimeError::new(
                    "SYSTEM_WEBVIEW_CREATION_STALLED",
                    message,
                ))
            }
        }
    }

    fn prepare_surface_parent_for_creation(
        &self,
        window: &Window,
        lifecycle_id: &str,
    ) -> RuntimeResult<bool> {
        #[cfg(windows)]
        {
            if window.is_visible().map_err(RuntimeError::tauri)? {
                return Ok(false);
            }
            self.begin_surface_host_initialization(window, lifecycle_id)?;
            Ok(true)
        }
        #[cfg(target_os = "macos")]
        {
            self.begin_surface_host_initialization(window, lifecycle_id)?;
            Ok(true)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (window, lifecycle_id);
            Ok(false)
        }
    }

    fn create_window_bounded(
        &self,
        lifecycle_id: &str,
        create: impl FnOnce() -> tauri::Result<Window> + Send + 'static,
    ) -> RuntimeResult<Window> {
        self.health.require_healthy()?;
        let stage = format!("native-window-create:{lifecycle_id}");
        let started = Instant::now();
        self.record_runtime_stage(&stage, "started", started);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("rion-window-create".to_owned())
            .spawn(move || {
                let result = create();
                if let Err(mpsc::SendError(Ok(stale_window))) = sender.send(result) {
                    let _ = stale_window.close();
                }
            })
            .map_err(|error| {
                RuntimeError::new("SYSTEM_WINDOW_CREATE_WORKER_FAILED", error.to_string())
            })?;
        match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
            Ok(Ok(window)) => {
                self.record_runtime_stage(stage, "completed", started);
                Ok(window)
            }
            Ok(Err(error)) => {
                self.record_runtime_stage(stage, "failed", started);
                Err(RuntimeError::tauri(error))
            }
            Err(error) => {
                self.record_runtime_stage(stage, "failed", started);
                self.health.mark_unhealthy();
                let failure_kind = match error {
                    mpsc::RecvTimeoutError::Timeout => "window-creation-timeout",
                    mpsc::RecvTimeoutError::Disconnected => "window-creation-worker-disconnected",
                };
                let message = format!(
                    "The native host window {lifecycle_id} did not finish creation within {}ms. Restart Rion Studio before launching another browser role.",
                    PLATFORM_CALLBACK_TIMEOUT.as_millis()
                );
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "SYSTEM_WEBVIEW_CREATION_STALLED",
                        "failureKind": failure_kind,
                        "message": message,
                        "windowId": lifecycle_id
                    }),
                );
                Err(RuntimeError::new(
                    "SYSTEM_WEBVIEW_CREATION_STALLED",
                    message,
                ))
            }
        }
    }

    fn begin_surface_host_initialization(
        &self,
        window: &Window,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        let requires_visible_parent =
            surface_host_initialization_requires_visible_parent(if cfg!(windows) {
                "windows"
            } else {
                "macos"
            });
        #[cfg(windows)]
        {
            debug_assert!(requires_visible_parent);
            let stage = format!("surface-host-visible:{lifecycle_id}");
            let started = Instant::now();
            self.record_runtime_stage(&stage, "started", started);
            if let Err(error) = set_windows_surface_host_initialization_visibility(window, true) {
                self.record_runtime_stage(stage, "failed", started);
                self.health.mark_unhealthy();
                return Err(error);
            }
            self.record_runtime_stage(stage, "completed", started);
        }
        #[cfg(target_os = "macos")]
        {
            let _ = (window, lifecycle_id);
            debug_assert!(!requires_visible_parent);
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (requires_visible_parent, window, lifecycle_id);
        }
        Ok(())
    }

    fn finish_surface_host_initialization(
        &self,
        window: &Window,
        initialized_for_operation: bool,
        lifecycle_id: &str,
    ) -> RuntimeResult<()> {
        if !initialized_for_operation {
            return Ok(());
        }
        #[cfg(windows)]
        {
            let stage = format!("surface-host-hidden:{lifecycle_id}");
            let started = Instant::now();
            self.record_runtime_stage(&stage, "started", started);
            if let Err(error) = set_windows_surface_host_initialization_visibility(window, false) {
                self.record_runtime_stage(stage, "failed", started);
                self.health.mark_unhealthy();
                return Err(error);
            }
            self.record_runtime_stage(stage, "completed", started);
        }
        #[cfg(target_os = "macos")]
        {
            let _ = (window, lifecycle_id);
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = (window, lifecycle_id);
        Ok(())
    }

    fn destroy_role(&self, role_id: &str) -> RuntimeResult<()> {
        {
            let mut state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            if state.close_coordinator.closing_tabs.contains(tab_id)
                || !state
                    .close_coordinator
                    .closing_roles
                    .insert(role_id.to_owned())
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_ALREADY_CLOSING",
                    "The runtime role is already closing.",
                ));
            }
        }
        let result = self.destroy_marked_role(role_id, None);
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_roles.remove(role_id);
        }
        result
    }

    fn destroy_marked_role(
        &self,
        role_id: &str,
        expected_tab_id: Option<&str>,
    ) -> RuntimeResult<()> {
        let released = self.release_marked_role_surfaces(role_id, expected_tab_id)?;
        self.commit_released_role(released)
    }

    fn release_marked_role_surfaces(
        &self,
        role_id: &str,
        expected_tab_id: Option<&str>,
    ) -> RuntimeResult<ReleasedRoleSurface> {
        let (tab_id, webview, lifecycle, surface_instance_id, webview_label, popup_labels) = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            if expected_tab_id.is_some_and(|expected| expected != tab_id) {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The runtime role moved before its close transaction completed.",
                ));
            }
            let surface = state
                .tabs
                .get(&tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .ok_or_else(|| {
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
            (
                tab_id,
                surface.webview.clone(),
                Arc::clone(&surface.lifecycle),
                surface.surface_instance_id.clone(),
                surface.webview.label().to_owned(),
                popup_labels,
            )
        };

        self.clear_role_keys(role_id);
        let surface_ids = self.managed_surface_ids_for_role(role_id)?;
        let isolation_result = if surface_ids.is_empty() {
            self.close_surface_and_wait(&webview, &lifecycle, role_id)?;
            Ok(())
        } else {
            // A role page, recovery replacement and its popups are independent
            // controllers. Request isolation concurrently so a wedged popup cannot
            // delay the exact game surface or multiply the two-second bound.
            std::thread::scope(|scope| {
                let handles = surface_ids
                    .iter()
                    .map(|instance_id| {
                        scope.spawn(move || {
                            self.close_managed_surface_and_wait(instance_id, role_id)
                        })
                    })
                    .collect::<Vec<_>>();
                let mut first_error = None;
                for handle in handles {
                    match handle.join() {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => {
                            first_error.get_or_insert(error);
                        }
                        Err(_) => {
                            first_error.get_or_insert_with(|| {
                                RuntimeError::new(
                                    "SYSTEM_SURFACE_CLOSE_WORKER_FAILED",
                                    "A native role surface close worker panicked.",
                                )
                            });
                        }
                    }
                }
                first_error.map_or(Ok(()), Err)
            })
        };
        isolation_result?;
        for label in popup_labels {
            self.forget_popup(&label);
        }
        if !self.managed_surface_ids_for_role(role_id)?.is_empty() {
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.",
            ));
        }

        Ok(ReleasedRoleSurface {
            role_id: role_id.to_owned(),
            surface_instance_id,
            tab_id,
            webview_label,
        })
    }

    fn commit_released_role(&self, released: ReleasedRoleSurface) -> RuntimeResult<()> {
        let mut state = self.state()?;
        let current_tab_id = state
            .role_tabs
            .get(&released.role_id)
            .cloned()
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The closed runtime role no longer has an authoritative mapping.",
                )
            })?;
        let current_surface = state
            .tabs
            .get(&released.tab_id)
            .and_then(|tab| tab.roles.get(&released.role_id))
            .map(|surface| {
                (
                    surface.webview.label(),
                    surface.surface_instance_id.as_str(),
                )
            });
        if current_surface.is_none_or(|(current_label, current_instance_id)| {
            !surface_close_commit_is_current(
                &current_tab_id,
                &released.tab_id,
                current_label,
                &released.webview_label,
            ) || current_instance_id != released.surface_instance_id
        }) {
            return Err(RuntimeError::new(
                "SYSTEM_SURFACE_CLOSE_STALE",
                "A newer runtime role surface superseded the closed handle.",
            ));
        }
        state.role_tabs.remove(&released.role_id);
        state.audible_webviews.remove(&released.webview_label);
        state.recovery_budgets.remove(&released.role_id);
        state.recovery_generations.remove(&released.role_id);
        state.recovering_roles.remove(&released.role_id);
        state
            .tabs
            .get_mut(&released.tab_id)
            .expect("the close transaction validated the runtime tab")
            .roles
            .remove(&released.role_id);
        Ok(())
    }

    fn destroy_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        let (role_ids, window_id) = {
            let state = self.state()?;
            let tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            (
                tab.roles.keys().cloned().collect::<Vec<_>>(),
                tab.window_id.clone(),
            )
        };
        {
            let mut state = self.state()?;
            if state.close_coordinator.closing_tabs.contains(tab_id)
                || role_ids
                    .iter()
                    .any(|role_id| state.close_coordinator.closing_roles.contains(role_id))
            {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_ALREADY_CLOSING",
                    "The runtime tab or one of its roles is already closing.",
                ));
            }
            state
                .close_coordinator
                .closing_tabs
                .insert(tab_id.to_owned());
            state
                .close_coordinator
                .closing_roles
                .extend(role_ids.iter().cloned());
        }
        let result = (|| -> RuntimeResult<()> {
            // A workspace's game surfaces are independent native controllers. Isolate
            // them concurrently so one wedged role cannot serialize every sibling.
            let released_roles = std::thread::scope(|scope| {
                let handles = role_ids
                    .iter()
                    .map(|role_id| {
                        scope
                            .spawn(move || self.release_marked_role_surfaces(role_id, Some(tab_id)))
                    })
                    .collect::<Vec<_>>();
                handles
                    .into_iter()
                    .map(|handle| {
                        handle.join().unwrap_or_else(|_| {
                            Err(RuntimeError::new(
                                "SYSTEM_SURFACE_CLOSE_WORKER_FAILED",
                                "A native workspace surface close worker panicked.",
                            ))
                        })
                    })
                    .collect::<RuntimeResult<Vec<_>>>()
            })?;
            let released_dividers = {
                let state = self.state()?;
                state
                    .tabs
                    .get(tab_id)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "SYSTEM_SURFACE_CLOSE_STALE",
                            "The runtime tab disappeared during divider cleanup.",
                        )
                    })?
                    .dividers
                    .iter()
                    .map(|divider| {
                        (
                            divider.index,
                            divider.surface_instance_id.clone(),
                            divider.webview.label().to_owned(),
                        )
                    })
                    .collect::<Vec<_>>()
            };
            for (_, instance_id, _) in &released_dividers {
                self.close_managed_divider(instance_id)?;
            }

            let mut state = self.state()?;
            if state.surface_registry.values().any(|surface| {
                surface.tab_id.as_deref() == Some(tab_id)
                    && surface.kind != ManagedSurfaceKind::Divider
                    && surface.phase.blocks_role_relaunch()
            }) {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                    "Rion Studio could not verify that every native game page stopped. The tab remains closed; restart Rion Studio before reopening these roles.",
                ));
            }
            let current_tab = state.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The runtime tab disappeared before its close transaction committed.",
                )
            })?;
            let roles_current = current_tab.roles.len() == released_roles.len()
                && released_roles.iter().all(|released| {
                    state.role_tabs.get(&released.role_id) == Some(&released.tab_id)
                        && current_tab
                            .roles
                            .get(&released.role_id)
                            .is_some_and(|surface| {
                                surface.surface_instance_id == released.surface_instance_id
                                    && surface.webview.label() == released.webview_label
                            })
                });
            let dividers_current = current_tab.dividers.len() == released_dividers.len()
                && released_dividers.iter().all(|(index, instance_id, label)| {
                    current_tab.dividers.iter().any(|divider| {
                        divider.index == *index
                            && divider.surface_instance_id == *instance_id
                            && divider.webview.label() == label
                    })
                });
            if !roles_current || !dividers_current {
                return Err(RuntimeError::new(
                    "SYSTEM_SURFACE_CLOSE_STALE",
                    "The runtime tab changed before its close transaction committed.",
                ));
            }
            for released in &released_roles {
                state.role_tabs.remove(&released.role_id);
                state.audible_webviews.remove(&released.webview_label);
                state.recovery_budgets.remove(&released.role_id);
                state.recovery_generations.remove(&released.role_id);
                state.recovering_roles.remove(&released.role_id);
            }
            state.tabs.remove(tab_id);
            state.launch_phases.remove(tab_id);
            Ok(())
        })();
        if let Ok(mut state) = self.state.lock() {
            state.close_coordinator.closing_tabs.remove(tab_id);
            role_ids.iter().for_each(|role_id| {
                state.close_coordinator.closing_roles.remove(role_id);
            });
        }
        if result.is_ok() {
            self.remove_empty_display_host(&window_id, true);
        }
        result
    }

    fn show_tab(&self, tab_id: &str, focus: bool) -> RuntimeResult<()> {
        self.request_tab_presentation(tab_id, focus, "effect")
            .map(|_| ())
            .map_err(|message| RuntimeError::new("TAURI_RUNTIME_VISIBILITY_FAILED", message))
    }

    fn set_role_audio_muted(&self, role_id: &str, muted: bool) -> RuntimeResult<()> {
        let (tab_id, previous_muted, webviews, popup_labels) = {
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
            (tab_id, tab.audio_muted, webviews, popup_labels)
        };
        let mut all_webviews = webviews;
        for label in popup_labels {
            let webview = self.app.get_webview(&label).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_POPUP_HANDLE_MISSING",
                    format!("Runtime popup {label} has no live native handle."),
                )
            })?;
            all_webviews.push(webview);
        }
        if let Err(failure) = apply_reversible_fanout(
            &all_webviews,
            |index, webview| {
                set_audio_muted(webview, muted)
                    .map_err(|error| format!("surface {index}: {}", error.message))
            },
            |index, webview| {
                set_audio_muted(webview, previous_muted)
                    .map_err(|error| format!("surface {index}: {}", error.message))
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_AUDIO_MUTE_FAILED",
                "Updating runtime tab audio mute",
                &failure,
            ));
        }
        let commit = (|| -> RuntimeResult<()> {
            let mut state = self.state()?;
            let tab = state.tabs.get_mut(&tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_AUDIO_STALE",
                    "The runtime tab stopped while updating audio mute.",
                )
            })?;
            if tab.audio_muted != previous_muted {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_AUDIO_STALE",
                    "The runtime tab audio state changed concurrently.",
                ));
            }
            tab.audio_muted = muted;
            Ok(())
        })();
        if let Err(error) = commit {
            let rollback_errors = rollback_reversible_fanout(&all_webviews, |index, webview| {
                set_audio_muted(webview, previous_muted)
                    .map_err(|error| format!("surface {index}: {}", error.message))
            });
            if !rollback_errors.is_empty() {
                self.health.mark_unhealthy();
                return Err(RuntimeError::new(
                    "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED",
                    format!(
                        "{} Compensation also failed: {}. Restart Rion Studio to recover safely.",
                        error.message,
                        rollback_errors.join("; ")
                    ),
                ));
            }
            return Err(error);
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

fn handle_browser_download(
    app: &AppHandle,
    role_id: Option<&str>,
    event: DownloadEvent<'_>,
) -> bool {
    let (payload, allowed) = match event {
        DownloadEvent::Requested { url, .. } => (
            json!({
                "state": "blocked",
                "roleId": role_id,
                "url": url
            }),
            false,
        ),
        DownloadEvent::Finished { url, path, success } => (
            json!({
                "state": if success { "completed" } else { "failed" },
                "roleId": role_id,
                "url": url,
                "path": path.map(|path| path.to_string_lossy().into_owned())
            }),
            true,
        ),
        _ => return false,
    };
    let _ = app.emit("rion://browser-download", payload);
    allowed
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

fn empty_performance_diagnostics(
    captured_at: String,
    platform: String,
    status: BrowserPerformanceDiagnosticStatus,
    high_refresh_rate_requested: bool,
    sample_duration: Duration,
) -> BrowserPerformanceDiagnosticsRecord {
    BrowserPerformanceDiagnosticsRecord {
        captured_at,
        platform,
        status,
        window_id: None,
        window_focused: false,
        display_refresh_rate_hz: None,
        high_refresh_rate_requested,
        sample_duration_ms: sample_duration.as_millis().min(u32::MAX as u128) as u32,
        surfaces: Vec::new(),
    }
}

fn decode_performance_diagnostic_readback(
    raw: &str,
) -> RuntimeResult<PerformanceDiagnosticReadback> {
    let value = serde_json::from_str::<Value>(raw).map_err(|error| {
        RuntimeError::new(
            "PERFORMANCE_DIAGNOSTIC_INVALID",
            format!("System WebView returned invalid diagnostic JSON: {error}"),
        )
    })?;
    let value = if let Some(nested) = value.as_str() {
        serde_json::from_str::<Value>(nested).map_err(|error| {
            RuntimeError::new(
                "PERFORMANCE_DIAGNOSTIC_INVALID",
                format!("System WebView returned invalid nested diagnostic JSON: {error}"),
            )
        })?
    } else {
        value
    };
    serde_json::from_value(value).map_err(|error| {
        RuntimeError::new(
            "PERFORMANCE_DIAGNOSTIC_INVALID",
            format!("System WebView returned an invalid diagnostic result: {error}"),
        )
    })
}

fn completed_performance_surface(
    surface: PerformanceDiagnosticSurface,
    mut readback: PerformanceDiagnosticReadback,
    display_refresh_rate_hz: Option<f64>,
) -> BrowserPerformanceSurfaceDiagnosticRecord {
    readback.graphics.error = readback.graphics.error.and_then(bounded_diagnostic_text);
    readback.graphics.renderer = readback.graphics.renderer.and_then(bounded_diagnostic_text);
    readback.graphics.vendor = readback.graphics.vendor.and_then(bounded_diagnostic_text);
    readback.graphics.webgl = diagnostic_availability(&readback.graphics.webgl);
    readback.graphics.webgl2 = diagnostic_availability(&readback.graphics.webgl2);
    readback.graphics.webgpu = diagnostic_availability(&readback.graphics.webgpu);
    let (slow_frame_count, missed_vsync_count) =
        frame_budget_diagnostics(&readback.frame_intervals_ms, display_refresh_rate_hz);
    BrowserPerformanceSurfaceDiagnosticRecord {
        role_id: surface.role_id,
        origin: surface.origin,
        document_visibility_state: match readback.document_visibility_state.as_str() {
            "visible" | "hidden" | "prerender" => readback.document_visibility_state,
            _ => "unknown".to_owned(),
        },
        document_has_focus: readback.document_has_focus,
        viewport_width: finite_non_negative(readback.viewport_width).unwrap_or(0.0),
        viewport_height: finite_non_negative(readback.viewport_height).unwrap_or(0.0),
        device_pixel_ratio: finite_non_negative(readback.device_pixel_ratio).unwrap_or(1.0),
        hardware_concurrency: readback.hardware_concurrency.min(1_024),
        frame_count: readback.frame_count,
        observed_duration_ms: finite_non_negative(readback.observed_duration_ms).unwrap_or(0.0),
        average_fps: readback
            .average_fps
            .and_then(finite_non_negative)
            .map(|value| value.min(1_000.0)),
        p50_frame_interval_ms: readback.p50_frame_interval_ms.and_then(finite_non_negative),
        p95_frame_interval_ms: readback.p95_frame_interval_ms.and_then(finite_non_negative),
        p99_frame_interval_ms: readback.p99_frame_interval_ms.and_then(finite_non_negative),
        longest_frame_interval_ms: readback
            .longest_frame_interval_ms
            .and_then(finite_non_negative),
        slow_frame_count,
        missed_vsync_count,
        long_task_count: readback.long_task_count.map(|value| value.min(2_048)),
        long_task_total_duration_ms: readback
            .long_task_total_duration_ms
            .and_then(finite_non_negative),
        longest_task_ms: readback.longest_task_ms.and_then(finite_non_negative),
        graphics: readback.graphics,
        high_refresh_rate_status: surface.high_refresh_rate_status,
        error: None,
    }
}

fn failed_performance_surface(
    surface: PerformanceDiagnosticSurface,
    error: String,
) -> BrowserPerformanceSurfaceDiagnosticRecord {
    BrowserPerformanceSurfaceDiagnosticRecord {
        role_id: surface.role_id,
        origin: surface.origin,
        document_visibility_state: "unknown".to_owned(),
        document_has_focus: false,
        viewport_width: 0.0,
        viewport_height: 0.0,
        device_pixel_ratio: 1.0,
        hardware_concurrency: 0,
        frame_count: 0,
        observed_duration_ms: 0.0,
        average_fps: None,
        p50_frame_interval_ms: None,
        p95_frame_interval_ms: None,
        p99_frame_interval_ms: None,
        longest_frame_interval_ms: None,
        slow_frame_count: None,
        missed_vsync_count: None,
        long_task_count: None,
        long_task_total_duration_ms: None,
        longest_task_ms: None,
        graphics: StateWebGraphicsRecord {
            error: None,
            renderer: None,
            vendor: None,
            webgl: "unknown".to_owned(),
            webgl2: "unknown".to_owned(),
            webgpu: "unknown".to_owned(),
        },
        high_refresh_rate_status: surface.high_refresh_rate_status,
        error: bounded_diagnostic_text(error),
    }
}

fn frame_budget_diagnostics(
    frame_intervals_ms: &[f64],
    display_refresh_rate_hz: Option<f64>,
) -> (Option<u32>, Option<u32>) {
    let Some(refresh_rate) =
        display_refresh_rate_hz.filter(|value| value.is_finite() && *value > 1.0)
    else {
        return (None, None);
    };
    let frame_budget_ms = 1_000.0 / refresh_rate;
    let slow_threshold_ms = frame_budget_ms * 1.5;
    let mut slow_frames = 0_u64;
    let mut missed_vsyncs = 0_u64;
    for interval in frame_intervals_ms
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        if interval <= slow_threshold_ms {
            continue;
        }
        slow_frames = slow_frames.saturating_add(1);
        let elapsed_budgets = (interval / frame_budget_ms).ceil().max(1.0) as u64;
        missed_vsyncs = missed_vsyncs.saturating_add(elapsed_budgets.saturating_sub(1));
    }
    (
        Some(slow_frames.min(u32::MAX as u64) as u32),
        Some(missed_vsyncs.min(u32::MAX as u64) as u32),
    )
}

fn bounded_diagnostic_text(value: String) -> Option<String> {
    (!value.is_empty()).then(|| value.chars().take(512).collect())
}

fn diagnostic_availability(value: &str) -> String {
    if matches!(value, "available" | "unavailable" | "unknown") {
        value.to_owned()
    } else {
        "unknown".to_owned()
    }
}

fn finite_non_negative(value: f64) -> Option<f64> {
    (value.is_finite() && value >= 0.0).then_some(value)
}

#[cfg(target_os = "macos")]
fn platform_display_refresh_rate(window: &Window) -> Option<f64> {
    unsafe extern "C" {
        fn rion_ns_window_display_refresh_rate(window: *mut std::ffi::c_void) -> f64;
    }
    let raw_window = window.ns_window().ok()?;
    finite_non_negative(unsafe { rion_ns_window_display_refresh_rate(raw_window) })
        .filter(|value| *value > 1.0)
}

#[cfg(windows)]
fn platform_display_refresh_rate(window: &Window) -> Option<f64> {
    use windows::Win32::Graphics::Gdi::{GetDC, GetDeviceCaps, ReleaseDC, VREFRESH};

    let hwnd = window.hwnd().ok()?;
    let device_context = unsafe { GetDC(Some(hwnd)) };
    if device_context.0.is_null() {
        return None;
    }
    let refresh_rate = unsafe { GetDeviceCaps(Some(device_context), VREFRESH) };
    unsafe {
        ReleaseDC(Some(hwnd), device_context);
    }
    (refresh_rate > 1).then_some(refresh_rate as f64)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_display_refresh_rate(_window: &Window) -> Option<f64> {
    None
}

fn surface_host_initialization_requires_visible_parent(platform: &str) -> bool {
    platform == "windows"
}

#[cfg(windows)]
fn set_windows_surface_host_initialization_visibility(
    window: &Window,
    visible: bool,
) -> RuntimeResult<()> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNOACTIVATE, ShowWindow},
    };

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?.0 as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let hwnd = HWND(hwnd as *mut std::ffi::c_void);
            let command = if visible { SW_SHOWNOACTIVATE } else { SW_HIDE };
            unsafe {
                let _ = ShowWindow(hwnd, command);
            }
            let _ = sender.send(());
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|error| {
            let action = if visible { "show" } else { "hide" };
            RuntimeError::new(
                "SYSTEM_WEBVIEW_CREATION_STALLED",
                format!(
                    "The Windows WebView2 parent window did not {action} within {}ms ({error}). Restart Rion Studio before launching another browser role.",
                    PLATFORM_CALLBACK_TIMEOUT.as_millis()
                ),
            )
        })
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
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(RuntimeError::io)?;
    }
    rion_platform::restrict_directory_to_current_user(directory)
        .map_err(|error| RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string()))?;

    let destination = directory.join(name);
    let temporary = directory.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(RuntimeError::io)?;
        file.write_all(value).map_err(RuntimeError::io)?;
        file.sync_all().map_err(RuntimeError::io)?;
        rion_platform::atomic_replace_file(&temporary, &destination)
            .map_err(|error| RuntimeError::new("SESSION_IMPORT_BACKUP_FAILED", error.to_string()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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
    let generation = config.generation;
    Ok(format!(
        r#"(() => {{
  if (globalThis.top !== globalThis || globalThis.__rionLocalStorageSyncObserver) return;
  const state = {{ token: {token}, origin: {origin}, keys: {keys}, generation: {generation}, disabled: false, inFlight: null, lastError: null, nextSequence: 1, previous: null, queued: null, timer: 0 }};
  const capture = () => state.keys.map((key) => [key, localStorage.getItem(key)]);
  function schedule() {{
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(publish, 100);
  }}
  function dispatch(item) {{
    if (item.generation !== state.generation) return;
    const internals = globalThis.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {{
      state.queued = item;
      schedule();
      return;
    }}
    const request = {{ ...item, sequence: state.nextSequence++, token: state.token }};
    state.inFlight = request;
    void internals.invoke("rion_local_storage_sync_changed", {{
      token: request.token,
      generation: request.generation,
      sequence: request.sequence,
      entries: request.entries
    }}).then(
      () => {{
        if (request.generation === state.generation) {{
          state.lastError = null;
          state.previous = request.serialized;
        }}
      }},
      (error) => {{
        if (request.generation === state.generation) state.lastError = String(error);
      }}
    ).then(() => {{
      if (state.inFlight !== request) return;
      state.inFlight = null;
      if (request.generation !== state.generation) {{
        schedule();
        return;
      }}
      const queued = state.queued;
      state.queued = null;
      if (queued && queued.serialized !== state.previous) dispatch(queued);
      else schedule();
    }});
  }}
  function publish() {{
    state.timer = 0;
    if (location.origin !== state.origin) return;
    const entries = capture();
    const serialized = JSON.stringify(entries);
    const item = {{ entries, generation: state.generation, serialized }};
    if (state.inFlight) {{
      state.queued = serialized === state.inFlight.serialized ? null : item;
      return;
    }}
    if (serialized === state.previous) return;
    dispatch(item);
  }}
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
      if (!next || (next.token !== state.token && !state.disabled)) return false;
      state.token = next.token;
      state.origin = next.origin;
      state.keys = [...next.keys];
      state.generation = next.generation;
      state.disabled = false;
      state.nextSequence = 1;
      state.queued = null;
      state.previous = null;
      schedule();
      return true;
    }},
    disable(expectedToken) {{
      if (expectedToken !== state.token) return false;
      if (state.timer) clearTimeout(state.timer);
      state.timer = 0;
      state.generation += 1;
      state.disabled = true;
      state.origin = "null";
      state.keys = [];
      state.queued = null;
      state.previous = null;
      return true;
    }},
    snapshot() {{ return {{ hasPrevious: state.previous !== null, lastError: state.lastError, pending: state.inFlight !== null || state.queued !== null }}; }}
  }});
  schedule();
}})();"#,
    ))
}

fn local_storage_sync_configure_script(
    config: &LocalStorageRuntimeConfig,
) -> RuntimeResult<String> {
    let observer = local_storage_sync_observer_script(config)?;
    let configuration = serde_json::to_string(&json!({
        "token": config.token,
        "generation": config.generation,
        "origin": config.origin,
        "keys": config.keys,
    }))
    .map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization configuration could not be encoded.",
        )
    })?;
    Ok(format!(
        "{observer}\nglobalThis.__rionLocalStorageSyncObserver?.configure?.({configuration});"
    ))
}

fn local_storage_sync_disable_script(token: &str) -> RuntimeResult<String> {
    let token = serde_json::to_string(token).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The localStorage synchronization capability could not be encoded.",
        )
    })?;
    Ok(format!(
        "globalThis.__rionLocalStorageSyncObserver?.disable?.({token});"
    ))
}

fn evaluate_local_storage_metadata_scripts(
    webview: &Webview,
    scripts: &[String],
) -> Result<(), String> {
    scripts
        .iter()
        .try_for_each(|script| webview.eval(script).map_err(|error| error.to_string()))
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

fn macro_overlay_document_start_script_template() -> Result<String, String> {
    let guard_token = serde_json::to_string(MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN)
        .map_err(|error| error.to_string())?;
    let trusted_event_guard_token = serde_json::to_string(MACRO_OVERLAY_TRUSTED_EVENT_GUARD_TOKEN)
        .map_err(|error| error.to_string())?;
    let binding_token =
        serde_json::to_string(MACRO_OVERLAY_BINDING_TOKEN).map_err(|error| error.to_string())?;
    let css_token =
        serde_json::to_string(MACRO_OVERLAY_CSS_TOKEN).map_err(|error| error.to_string())?;
    let with_guard = replace_single_script_token(
        MACRO_OVERLAY_RUNTIME_SOURCE,
        &guard_token,
        MACRO_OVERLAY_SHORTCUT_GUARD_SOURCE.trim(),
    )?;
    let with_trusted_event_guard = replace_single_script_token(
        &with_guard,
        &trusted_event_guard_token,
        MACRO_OVERLAY_TRUSTED_EVENT_GUARD_SOURCE,
    )?;
    let css = serde_json::to_string(&format!("{DESIGN_TOKENS_CSS}\n{MACRO_OVERLAY_CSS}"))
        .map_err(|error| error.to_string())?;
    let runtime = replace_single_script_token(&with_trusted_event_guard, &css_token, &css)?;
    replace_single_script_token(
        &runtime,
        &binding_token,
        TAURI_MACRO_OVERLAY_BRIDGE_SOURCE.trim(),
    )
}

fn macro_overlay_document_start_script(template: &str, capability: &str) -> Result<String, String> {
    let capability_token =
        serde_json::to_string(MACRO_OVERLAY_CAPABILITY_TOKEN).map_err(|error| error.to_string())?;
    let capability = serde_json::to_string(capability).map_err(|error| error.to_string())?;
    replace_single_script_token(template, &capability_token, &capability)
}

fn runtime_indicator_document_start_script() -> Result<String, String> {
    let css_token =
        serde_json::to_string(RUNTIME_INDICATOR_CSS_TOKEN).map_err(|error| error.to_string())?;
    let css = serde_json::to_string(&format!("{DESIGN_TOKENS_CSS}\n{RUNTIME_INDICATOR_CSS}"))
        .map_err(|error| error.to_string())?;
    replace_single_script_token(RUNTIME_INDICATOR_RUNTIME_SOURCE, &css_token, &css)
}

fn should_refresh_macro_overlay(role_ids: &[String], role_id: &str) -> bool {
    role_ids.is_empty() || role_ids.iter().any(|candidate| candidate == role_id)
}

fn prepare_restore_session_for_persist(
    session: &mut RuntimeRestoreSessionRecord,
    clean_exit: bool,
) {
    session.schema_version = 2;
    session.updated_at = chrono::Utc::now().to_rfc3339();
    session.clean_exit = clean_exit;
    if clean_exit {
        session.restore_in_progress_window_ids.clear();
    }
    session.windows.clear();
}

fn refresh_macro_overlay_handles<T, E>(
    handles: impl IntoIterator<Item = T>,
    mut refresh: impl FnMut(T) -> Result<(), E>,
) {
    for handle in handles {
        let _ = refresh(handle);
    }
}

fn reload_runtime_tab_handles<T, E>(
    handles: impl IntoIterator<Item = T>,
    mut reload: impl FnMut(T) -> Result<(), E>,
) -> Result<(), E> {
    let mut first_error = None;
    for handle in handles {
        if let Err(error) = reload(handle)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn should_release_macros_for_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn should_defer_document_navigation(platform: &str, controlled: bool) -> bool {
    platform == "windows" && !controlled
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn complete_navigation_deferral_once<E>(
    completed: &AtomicBool,
    complete: impl FnOnce() -> Result<(), E>,
) -> Result<bool, E> {
    if completed
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(false);
    }
    complete().map(|()| true)
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

fn native_font_document_start_script() -> String {
    BROWSER_FONTS_RUNTIME_SOURCE.to_owned()
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

fn runtime_target_requires_placement_reapply(presentation: &str, fullscreen: bool) -> bool {
    presentation != "fullscreen" || !fullscreen
}

fn logical_window_position(physical_x: i32, physical_y: i32, scale: f64) -> (i32, i32) {
    let scale = normalized_scale_factor(scale);
    (
        (physical_x as f64 / scale).round() as i32,
        (physical_y as f64 / scale).round() as i32,
    )
}

fn physical_window_position(logical_x: i32, logical_y: i32, scale: f64) -> (i32, i32) {
    let scale = normalized_scale_factor(scale);
    (
        (logical_x as f64 * scale).round() as i32,
        (logical_y as f64 * scale).round() as i32,
    )
}

fn normalized_scale_factor(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn runtime_window_resize_is_actionable(width: u32, height: u32, minimized: bool) -> bool {
    width > 0 && height > 0 && !minimized
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
        // asynchronously. Let the previous role consume its direct responder
        // dispatch before handing off to another role. Same-role sequences stay fast.
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
fn configure_platform_high_refresh_rate(
    webview: &Webview,
    enabled: bool,
) -> HighRefreshRateDiagnosticStatus {
    if !enabled {
        return HighRefreshRateDiagnosticStatus::Disabled;
    }

    unsafe extern "C" {
        fn rion_wk_enable_high_refresh_rate(webview: *mut std::ffi::c_void) -> i32;
    }

    let label = webview.label().to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let outcome = match webview.with_webview(move |platform_webview| {
        let status = unsafe { rion_wk_enable_high_refresh_rate(platform_webview.inner()) };
        let _ = sender.send(status);
    }) {
        Ok(()) => match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
            Ok(0) => HighRefreshRateDiagnosticStatus::Applied,
            Ok(1) => HighRefreshRateDiagnosticStatus::Unavailable,
            Ok(_) => HighRefreshRateDiagnosticStatus::Failed,
            Err(_) => HighRefreshRateDiagnosticStatus::Timeout,
        },
        Err(_) => HighRefreshRateDiagnosticStatus::ScheduleFailed,
    };
    eprintln!(
        "System WebView macOS high refresh rate: label={label} status={}.",
        high_refresh_rate_status_label(outcome)
    );
    outcome
}

#[cfg(not(target_os = "macos"))]
fn configure_platform_high_refresh_rate(
    _webview: &Webview,
    _enabled: bool,
) -> HighRefreshRateDiagnosticStatus {
    HighRefreshRateDiagnosticStatus::NotApplicable
}

#[cfg(any(target_os = "macos", test))]
fn high_refresh_rate_status_label(status: HighRefreshRateDiagnosticStatus) -> &'static str {
    match status {
        HighRefreshRateDiagnosticStatus::Applied => "applied",
        HighRefreshRateDiagnosticStatus::Disabled => "disabled",
        HighRefreshRateDiagnosticStatus::Unavailable => "unavailable",
        HighRefreshRateDiagnosticStatus::Failed => "failed",
        HighRefreshRateDiagnosticStatus::Timeout => "timeout",
        HighRefreshRateDiagnosticStatus::ScheduleFailed => "schedule-failed",
        HighRefreshRateDiagnosticStatus::NotApplicable => "not-applicable",
    }
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
fn install_document_navigation_macro_release_handler(
    webview: &Webview,
    app: AppHandle,
    role_id: &str,
) -> RuntimeResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    let webview_label = webview.label().to_owned();
    let role_id = role_id.to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| {
                    register_windows_document_navigation_handler(&core, app, role_id, webview_label)
                })
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_NAVIGATION_HANDLER_TIMEOUT",
                "WebView2 document navigation handler installation timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_NAVIGATION_HANDLER_FAILED", message))
}

#[cfg(windows)]
fn register_windows_document_navigation_handler(
    core_webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    callback_app: AppHandle,
    role_id: String,
    webview_label: String,
) -> windows::core::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
        WebResourceRequestedEventHandler,
    };
    use windows::core::HSTRING;

    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_core, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let Some(state) = callback_app.try_state::<crate::CoreState>() else {
            return Ok(());
        };
        if !state
            .runtime
            .should_defer_windows_document_navigation(&webview_label)
        {
            return Ok(());
        }
        // SAFETY: WebView2 supplied these event args to this callback, and the
        // callback is still executing on the owning UI thread.
        let deferral = match unsafe { args.GetDeferral() } {
            Ok(deferral) => deferral,
            Err(error) => {
                emit_windows_document_navigation_error(
                    &callback_app,
                    "SYSTEM_NAVIGATION_DEFERRAL_FAILED",
                    "The Windows document request could not be deferred and was allowed to continue.",
                    &role_id,
                    &webview_label,
                    &error.to_string(),
                );
                return Ok(());
            }
        };
        let completed = Arc::new(AtomicBool::new(false));
        let deferral_token = retain_windows_document_navigation_deferral(deferral);
        let core = Arc::clone(&state.core);
        let release_app = callback_app.clone();
        let release_role_id = role_id.clone();
        let release_webview_label = webview_label.clone();
        tauri::async_runtime::spawn(async move {
            let release = core
                .invoke_async(CoreCommand::MacroReleaseRole {
                    role_id: release_role_id.clone(),
                })
                .await;
            if let Err(error) = release {
                emit_windows_document_navigation_error(
                    &release_app,
                    "SYSTEM_NAVIGATION_MACRO_RELEASE_FAILED",
                    "Macro input could not be released before a Windows document request; the original request was allowed to continue.",
                    &release_role_id,
                    &release_webview_label,
                    &error.to_string(),
                );
            }
            let scheduled_completed = Arc::clone(&completed);
            let completion_app = release_app.clone();
            let completion_role_id = release_role_id.clone();
            let completion_webview_label = release_webview_label.clone();
            let scheduling = release_app.run_on_main_thread(move || {
                if let Err(error) = complete_windows_document_navigation_deferral(
                    deferral_token,
                    &scheduled_completed,
                ) {
                    emit_windows_document_navigation_error(
                        &completion_app,
                        "SYSTEM_NAVIGATION_DEFERRAL_COMPLETE_FAILED",
                        "The Windows document request deferral could not be completed.",
                        &completion_role_id,
                        &completion_webview_label,
                        &error,
                    );
                }
            });
            if let Err(error) = scheduling {
                emit_windows_document_navigation_error(
                    &release_app,
                    "SYSTEM_NAVIGATION_DEFERRAL_SCHEDULE_FAILED",
                    "The Windows document request could not be resumed because the app event loop was unavailable.",
                    &release_role_id,
                    &release_webview_label,
                    &error.to_string(),
                );
            }
        });
        Ok(())
    }));
    for pattern in ["http://*", "https://*"] {
        // SAFETY: `core_webview` remains owned by the WebView2 UI thread for
        // the duration of handler registration.
        unsafe {
            core_webview.AddWebResourceRequestedFilter(
                &HSTRING::from(pattern),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
            )?;
        }
    }
    let mut token = 0;
    // SAFETY: The handler and event token are valid for this registration call,
    // which runs on the WebView2 UI thread.
    unsafe { core_webview.add_WebResourceRequested(&handler, &mut token) }
}

#[cfg(windows)]
fn retain_windows_document_navigation_deferral(
    deferral: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
) -> u64 {
    let token = WINDOWS_DOCUMENT_NAVIGATION_DEFERRAL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    WINDOWS_DOCUMENT_NAVIGATION_DEFERRALS.with(|deferrals| {
        let previous = deferrals.borrow_mut().insert(token, deferral);
        debug_assert!(
            previous.is_none(),
            "document navigation deferral token reused"
        );
    });
    token
}

#[cfg(windows)]
fn complete_windows_document_navigation_deferral(
    token: u64,
    completed: &AtomicBool,
) -> Result<bool, String> {
    complete_navigation_deferral_once(completed, || {
        let deferral = WINDOWS_DOCUMENT_NAVIGATION_DEFERRALS
            .with(|deferrals| deferrals.borrow_mut().remove(&token))
            .ok_or_else(|| "The Windows document request deferral was not found.".to_owned())?;
        unsafe { deferral.Complete() }.map_err(|error| error.to_string())
    })
}

#[cfg(windows)]
fn emit_windows_document_navigation_error(
    app: &AppHandle,
    code: &str,
    message: &str,
    role_id: &str,
    webview_label: &str,
    reason: &str,
) {
    let _ = app.emit(
        "rion://shell-error",
        json!({
            "code": code,
            "message": message,
            "reason": reason,
            "roleId": role_id,
            "webviewLabel": webview_label
        }),
    );
}

#[cfg(not(windows))]
fn install_document_navigation_macro_release_handler(
    _webview: &Webview,
    _app: AppHandle,
    _role_id: &str,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
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

#[cfg(windows)]
fn dispatch_runtime_tab_shortcut(app: &AppHandle, webview_label: &str, direction: &str) {
    let Some(state) = app.try_state::<crate::CoreState>() else {
        return;
    };
    let Some(window_id) = state.runtime.window_id_for_webview(webview_label) else {
        return;
    };
    let target = state
        .runtime
        .preview_adjacent_tab_activation(&window_id, direction)
        .ok();
    if let Some((tab_id, false)) = target {
        let _ = crate::commit_previewed_tab_selection(app, &state, &window_id, &tab_id);
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

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_application_shortcut_command(
    virtual_key: u32,
    control: bool,
    alt: bool,
    meta: bool,
    shift: bool,
    repeat: bool,
) -> Option<crate::application_menu::ApplicationShortcutCommand> {
    use crate::application_menu::ApplicationShortcutCommand;

    if virtual_key == 0x7A {
        return (!control && !alt && !meta && !shift && !repeat)
            .then_some(ApplicationShortcutCommand::ToggleFullscreen);
    }
    if virtual_key == 0x4E {
        return (control && !alt && !meta && !shift && !repeat)
            .then_some(ApplicationShortcutCommand::NewGameWindow);
    }
    windows_role_zoom_action(virtual_key, control, alt, meta, shift).map(|action| match action {
        "in" => ApplicationShortcutCommand::ZoomIn,
        "out" => ApplicationShortcutCommand::ZoomOut,
        _ => ApplicationShortcutCommand::ZoomReset,
    })
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
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() || action.is_null() {
            return;
        }
        let context = unsafe { &*(context.cast::<MacRoleZoomShortcutContext>()) };
        let Ok(action) = unsafe { std::ffi::CStr::from_ptr(action) }.to_str() else {
            return;
        };
        dispatch_role_zoom_shortcut(&context.app, &context.webview_label, action);
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn drop_macos_role_zoom_shortcut_context(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !context.is_null() {
            drop(unsafe { Box::from_raw(context.cast::<MacRoleZoomShortcutContext>()) });
        }
    }));
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
            COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
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
                    let mut physical_status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    args.PhysicalKeyStatus(&mut physical_status)?;
                    let pressed = |key: u16| GetKeyState(i32::from(key)) < 0;
                    let control = pressed(VK_CONTROL.0);
                    let alt = pressed(VK_MENU.0);
                    let meta = pressed(VK_LWIN.0) || pressed(VK_RWIN.0);
                    let shift = pressed(VK_SHIFT.0);
                    if virtual_key == 0x09 && control && !alt && !meta {
                        args.SetHandled(true)?;
                        dispatch_runtime_tab_shortcut(
                            &shortcut_app,
                            &shortcut_label,
                            if shift { "previous" } else { "next" },
                        );
                        return Ok(());
                    }
                    let command = windows_application_shortcut_command(
                        virtual_key,
                        control,
                        alt,
                        meta,
                        shift,
                        physical_status.WasKeyDown.as_bool(),
                    );
                    let Some(command) = command else {
                        return Ok(());
                    };
                    args.SetHandled(true)?;
                    let result = shortcut_app
                        .try_state::<crate::CoreState>()
                        .ok_or_else(|| "The Rion Studio runtime is unavailable.".to_owned())
                        .and_then(|state| {
                            crate::application_menu::execute_shortcut(
                                &shortcut_app,
                                &state,
                                command,
                                crate::application_menu::ApplicationShortcutTarget::RoleWebview(
                                    &shortcut_label,
                                ),
                            )
                        });
                    if let Err(message) = result {
                        let _ = shortcut_app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "TAURI_APPLICATION_SHORTCUT_FAILED",
                                "message": message
                            }),
                        );
                    }
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

#[cfg(target_os = "macos")]
fn platform_role_surface_setup(
    webview: &Webview,
    _app: AppHandle,
    _target: SurfaceFailureTarget,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    unsafe extern "C" {
        fn rion_wk_install_security_policy(webview: *mut std::ffi::c_void) -> bool;
        fn rion_wk_track_surface(
            webview: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
            isolated_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
            released_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
            context_destructor: unsafe extern "C" fn(*mut std::ffi::c_void),
        ) -> u64;
    }

    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let context = Arc::into_raw(Arc::clone(&tracker)) as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = webview.with_webview(move |platform_webview| {
        let native = platform_webview.inner();
        let security_installed = unsafe { rion_wk_install_security_policy(native) };
        let token = if security_installed {
            unsafe {
                rion_wk_track_surface(
                    native,
                    context as *mut std::ffi::c_void,
                    macos_surface_isolated,
                    macos_surface_released,
                    drop_macos_surface_context,
                )
            }
        } else {
            0
        };
        let _ = sender.send((security_installed, token));
    }) {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::tauri(error));
    }
    let (security_installed, token) =
        receiver
            .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
            .map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_ROLE_SETUP_TIMEOUT",
                    "WKWebView security and lifecycle setup timed out.",
                )
            })?;
    if !security_installed || token == 0 {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::new(
            if security_installed {
                "SYSTEM_SURFACE_LIFECYCLE_FAILED"
            } else {
                "SYSTEM_SECURITY_POLICY_FAILED"
            },
            if security_installed {
                "WKWebView surface lifecycle registration failed."
            } else {
                "WKWebView could not install the JavaScript dialog and deny-by-default permission policy."
            },
        ));
    }
    tracker.native_token.store(token, Ordering::Release);
    Ok(tracker)
}

#[cfg(windows)]
fn platform_role_surface_setup(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    use webview2_com::{
        BrowserProcessExitedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_STATE_DENY, COREWEBVIEW2_PROCESS_FAILED_KIND,
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL, ICoreWebView2, ICoreWebView2_14,
            ICoreWebView2Environment5,
        },
        PermissionRequestedEventHandler, ProcessFailedEventHandler,
        ServerCertificateErrorDetectedEventHandler,
    };
    use windows::core::Interface;

    let navigation_role_id = match &target {
        SurfaceFailureTarget::Role { role_id, .. } => role_id.clone(),
        _ => {
            return Err(RuntimeError::new(
                "SYSTEM_ROLE_SETUP_FAILED",
                "WebView2 role setup requires a role surface target.",
            ));
        }
    };
    let navigation_webview_label = webview.label().to_owned();
    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let callback_tracker = Arc::clone(&tracker);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> Result<(u32, u64), String> {
                let controller = platform_webview.controller();
                let core: ICoreWebView2 = controller
                    .CoreWebView2()
                    .map_err(|error| error.to_string())?;
                let mut browser_process_id = 0;
                core.BrowserProcessId(&mut browser_process_id)
                    .map_err(|error| error.to_string())?;

                let environment: ICoreWebView2Environment5 = platform_webview
                    .environment()
                    .cast()
                    .map_err(|error| error.to_string())?;
                let browser_handler = BrowserProcessExitedEventHandler::create(Box::new(
                    move |_environment, _args| {
                        callback_tracker.mark_browser_process_exited();
                        Ok(())
                    },
                ));
                let mut browser_token = 0;
                environment
                    .add_BrowserProcessExited(&browser_handler, &mut browser_token)
                    .map_err(|error| error.to_string())?;

                let permission_handler =
                    PermissionRequestedEventHandler::create(Box::new(move |_webview, args| {
                        if let Some(args) = args {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        }
                        Ok(())
                    }));
                let mut permission_token = 0;
                core.add_PermissionRequested(&permission_handler, &mut permission_token)
                    .map_err(|error| error.to_string())?;

                let certificate_handler = ServerCertificateErrorDetectedEventHandler::create(
                    Box::new(move |_webview, args| {
                        if let Some(args) = args {
                            args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)?;
                        }
                        Ok(())
                    }),
                );
                let certificate_core: ICoreWebView2_14 =
                    core.cast().map_err(|error| error.to_string())?;
                let mut certificate_token = 0;
                certificate_core
                    .add_ServerCertificateErrorDetected(
                        &certificate_handler,
                        &mut certificate_token,
                    )
                    .map_err(|error| error.to_string())?;

                let event_app = app.clone();
                let event_target = target.clone();
                let process_handler =
                    ProcessFailedEventHandler::create(Box::new(move |_webview, args| {
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
                            state.runtime.handle_surface_process_failure(
                                event_target.clone(),
                                webview2_process_failure_reason(kind).to_owned(),
                                webview2_process_failure_scope(kind),
                            );
                        }
                        Ok(())
                    }));
                let mut process_token = 0;
                core.add_ProcessFailed(&process_handler, &mut process_token)
                    .map_err(|error| error.to_string())?;

                register_windows_document_navigation_handler(
                    &core,
                    app.clone(),
                    navigation_role_id.clone(),
                    navigation_webview_label.clone(),
                )
                .map_err(|error| error.to_string())?;

                Ok((browser_process_id, controller.as_raw() as usize as u64))
            })();
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    let (browser_process_id, controller_identity) = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_ROLE_SETUP_TIMEOUT",
                "WebView2 identity, security, lifecycle, and process setup timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_ROLE_SETUP_FAILED", message))?;
    tracker
        .browser_process_id
        .store(u64::from(browser_process_id), Ordering::Release);
    tracker
        .controller_identity
        .store(controller_identity, Ordering::Release);
    Ok(tracker)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_role_surface_setup(
    webview: &Webview,
    _app: AppHandle,
    _target: SurfaceFailureTarget,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    let tracker = platform_surface_lifecycle_tracker(webview)?;
    install_platform_security_policy(webview)?;
    Ok(tracker)
}

#[cfg(windows)]
fn platform_surface_lifecycle_tracker(
    webview: &Webview,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    use webview2_com::{
        BrowserProcessExitedEventHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Environment5},
    };
    use windows::core::Interface;

    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let callback_tracker = Arc::clone(&tracker);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> Result<(u32, u64), String> {
                let controller = platform_webview.controller();
                let core: ICoreWebView2 = platform_webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| error.to_string())?;
                let mut browser_process_id = 0;
                core.BrowserProcessId(&mut browser_process_id)
                    .map_err(|error| error.to_string())?;
                let environment: ICoreWebView2Environment5 = platform_webview
                    .environment()
                    .cast()
                    .map_err(|error| error.to_string())?;
                let handler = BrowserProcessExitedEventHandler::create(Box::new(
                    move |_environment, _args| {
                        callback_tracker.mark_browser_process_exited();
                        Ok(())
                    },
                ));
                let mut token = 0;
                environment
                    .add_BrowserProcessExited(&handler, &mut token)
                    .map_err(|error| error.to_string())?;
                Ok((browser_process_id, controller.as_raw() as usize as u64))
            })();
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    let (browser_process_id, controller_identity) = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_LIFECYCLE_TIMEOUT",
                "WebView2 surface lifecycle registration timed out.",
            )
        })?
        .map_err(|message| RuntimeError::new("SYSTEM_SURFACE_LIFECYCLE_FAILED", message))?;
    tracker
        .browser_process_id
        .store(u64::from(browser_process_id), Ordering::Release);
    tracker
        .controller_identity
        .store(controller_identity, Ordering::Release);
    Ok(tracker)
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_surface_isolated(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let tracker = unsafe { &*(context.cast::<SurfaceLifecycleTracker>()) };
        tracker.mark_isolated();
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn macos_surface_released(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if context.is_null() {
            return;
        }
        let tracker = unsafe { &*(context.cast::<SurfaceLifecycleTracker>()) };
        tracker.mark_native_surface_released();
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn drop_macos_surface_context(context: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !context.is_null() {
            drop(unsafe { Arc::from_raw(context.cast::<SurfaceLifecycleTracker>()) });
        }
    }));
}

#[cfg(target_os = "macos")]
fn platform_surface_lifecycle_tracker(
    webview: &Webview,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    unsafe extern "C" {
        fn rion_wk_track_surface(
            webview: *mut std::ffi::c_void,
            context: *mut std::ffi::c_void,
            isolated_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
            released_callback: unsafe extern "C" fn(*mut std::ffi::c_void),
            context_destructor: unsafe extern "C" fn(*mut std::ffi::c_void),
        ) -> u64;
    }

    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    let context = Arc::into_raw(Arc::clone(&tracker)) as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = webview.with_webview(move |platform_webview| {
        let token = unsafe {
            rion_wk_track_surface(
                platform_webview.inner(),
                context as *mut std::ffi::c_void,
                macos_surface_isolated,
                macos_surface_released,
                drop_macos_surface_context,
            )
        };
        let _ = sender.send(token);
    }) {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::tauri(error));
    }
    let token = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_LIFECYCLE_TIMEOUT",
                "WKWebView surface lifecycle registration timed out.",
            )
        })?;
    if token == 0 {
        drop(unsafe { Arc::from_raw(context as *const SurfaceLifecycleTracker) });
        return Err(RuntimeError::new(
            "SYSTEM_SURFACE_LIFECYCLE_FAILED",
            "WKWebView surface lifecycle registration failed.",
        ));
    }
    tracker.native_token.store(token, Ordering::Release);
    Ok(tracker)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_surface_lifecycle_tracker(
    _webview: &Webview,
) -> RuntimeResult<Arc<SurfaceLifecycleTracker>> {
    let tracker = Arc::new(SurfaceLifecycleTracker::default());
    tracker.mark_native_surface_released();
    Ok(tracker)
}

#[cfg(target_os = "macos")]
fn quiesce_platform_surface(
    _webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    unsafe extern "C" {
        fn rion_wk_quiesce_surface(token: u64) -> bool;
    }
    let token = lifecycle.native_token.load(Ordering::Acquire);
    if token == 0 || !unsafe { rion_wk_quiesce_surface(token) } {
        return Err(RuntimeError::new(
            "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
            "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn quiesce_platform_surface(
    webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    use windows::core::Interface;

    let expected_process_id = lifecycle.browser_process_id.load(Ordering::Acquire) as u32;
    let expected_controller_identity = lifecycle.controller_identity.load(Ordering::Acquire);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let result = (|| -> windows::core::Result<()> {
                let actual_controller_identity = controller.as_raw() as usize as u64;
                let core: ICoreWebView2 = controller.CoreWebView2()?;
                let mut process_id = 0;
                core.BrowserProcessId(&mut process_id)?;
                if !windows_surface_identity_matches(
                    expected_controller_identity,
                    actual_controller_identity,
                    expected_process_id,
                    process_id,
                ) {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80004005_u32 as i32,
                    )));
                }
                core.Stop()?;
                core.Navigate(&windows::core::HSTRING::from("about:blank"))?;
                controller.Close()
            })()
            .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    receiver
        .recv_timeout(SURFACE_ISOLATION_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                "WebView2 surface identity verification timed out.",
            )
        })?
        .map_err(|message| {
            RuntimeError::new(
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
                format!("WebView2 surface identity verification failed: {message}"),
            )
        })?;
    lifecycle.mark_native_surface_released();
    lifecycle.mark_isolated();
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn quiesce_platform_surface(
    _webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<()> {
    lifecycle.mark_native_surface_released();
    lifecycle.mark_isolated();
    Ok(())
}

#[cfg(windows)]
fn install_process_failure_monitor(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
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
            let event_target = target.clone();
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
                    state.runtime.handle_surface_process_failure(
                        event_target.clone(),
                        webview2_process_failure_reason(kind).to_owned(),
                        webview2_process_failure_scope(kind),
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

#[cfg(windows)]
fn webview2_process_failure_scope(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> SurfaceFailureScope {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
        SurfaceFailureScope::Browser
    } else {
        SurfaceFailureScope::Renderer
    }
}

#[cfg(not(windows))]
fn install_process_failure_monitor(
    _webview: &Webview,
    _app: AppHandle,
    _target: SurfaceFailureTarget,
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
pub(crate) struct RuntimeError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
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
    use std::sync::atomic::AtomicUsize;
    use uuid::Uuid;

    #[test]
    fn reversible_fanout_rolls_back_every_attempted_native_mutation() {
        let values = Mutex::new(vec![false, false, false]);
        let rollback_order = Mutex::new(Vec::new());
        let failure = apply_reversible_fanout(
            &[0, 1, 2],
            |index, _| {
                values.lock().unwrap()[index] = true;
                if index == 1 {
                    Err("second surface rejected the update".to_owned())
                } else {
                    Ok(())
                }
            },
            |index, _| {
                values.lock().unwrap()[index] = false;
                rollback_order.lock().unwrap().push(index);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(
            failure,
            ReversibleFanoutFailure {
                apply_error: "second surface rejected the update".to_owned(),
                rollback_errors: Vec::new(),
            }
        );
        assert_eq!(*values.lock().unwrap(), vec![false, false, false]);
        assert_eq!(*rollback_order.lock().unwrap(), vec![1, 0]);
    }

    #[test]
    fn reversible_fanout_reports_failed_compensation() {
        let failure = apply_reversible_fanout(
            &["first", "second"],
            |index, _| {
                if index == 1 {
                    Err("apply failed".to_owned())
                } else {
                    Ok(())
                }
            },
            |index, item| {
                if index == 0 {
                    Err(format!("rollback {item} failed"))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();

        assert_eq!(failure.rollback_errors, vec!["rollback first failed"]);
        let error = reversible_fanout_runtime_error("APPLY_FAILED", "Updating surfaces", &failure);
        assert_eq!(error.code, "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED");
        assert!(error.message.contains("Restart Rion Studio"));
    }

    #[test]
    fn window_close_does_not_hide_when_placement_persistence_fails() {
        let hidden = AtomicBool::new(false);
        let failure = apply_window_close_to_hide_transaction(
            || Err("placement failed".to_owned()),
            || {
                hidden.store(true, Ordering::Release);
                Ok(())
            },
            || Ok(()),
            || Ok(()),
        )
        .unwrap_err();

        assert_eq!(failure.apply_error, "placement failed");
        assert!(failure.rollback_errors.is_empty());
        assert!(!hidden.load(Ordering::Acquire));
    }

    #[test]
    fn window_close_restores_visibility_when_restore_persistence_fails() {
        let visible = AtomicBool::new(true);
        let failure = apply_window_close_to_hide_transaction(
            || Ok(()),
            || {
                visible.store(false, Ordering::Release);
                Ok(())
            },
            || Err("restore session failed".to_owned()),
            || {
                visible.store(true, Ordering::Release);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(failure.apply_error, "restore session failed");
        assert!(failure.rollback_errors.is_empty());
        assert!(visible.load(Ordering::Acquire));
    }

    #[test]
    fn window_close_reports_failed_visibility_compensation() {
        let failure = apply_window_close_to_hide_transaction(
            || Ok(()),
            || Err("hide failed".to_owned()),
            || Ok(()),
            || Err("show failed".to_owned()),
        )
        .unwrap_err();

        assert_eq!(failure.apply_error, "hide failed");
        assert_eq!(failure.rollback_errors, vec!["show failed"]);
    }

    #[test]
    fn native_runtime_work_loop_is_fifo_and_non_overlapping() {
        let (sender, receiver) = mpsc::channel();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let worker_observed = Arc::clone(&observed);
        let worker_active = Arc::clone(&active);
        let worker_peak = Arc::clone(&peak);
        let worker = std::thread::spawn(move || {
            run_serial_runtime_work_loop(receiver, |value| {
                let current = worker_active.fetch_add(1, Ordering::SeqCst) + 1;
                worker_peak.fetch_max(current, Ordering::SeqCst);
                worker_observed.lock().unwrap().push(value);
                std::thread::yield_now();
                worker_active.fetch_sub(1, Ordering::SeqCst);
            });
        });

        for value in 0..64 {
            sender.send(value).unwrap();
        }
        drop(sender);
        worker.join().unwrap();

        assert_eq!(*observed.lock().unwrap(), (0..64).collect::<Vec<_>>());
        assert_eq!(peak.load(Ordering::SeqCst), 1);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn runtime_persistence_preserves_an_active_restore_fence_until_clean_exit() {
        let mut session = RuntimeRestoreSessionRecord {
            schema_version: 1,
            session_generation: 4,
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
            clean_exit: true,
            last_focused_window_id: Some("window-1".to_owned()),
            restore_in_progress_window_ids: vec!["window-1".to_owned()],
            windows: Vec::new(),
        };

        prepare_restore_session_for_persist(&mut session, false);
        assert_eq!(session.schema_version, 2);
        assert!(!session.clean_exit);
        assert_eq!(
            session.restore_in_progress_window_ids,
            vec!["window-1".to_owned()]
        );

        prepare_restore_session_for_persist(&mut session, true);
        assert!(session.clean_exit);
        assert!(session.restore_in_progress_window_ids.is_empty());
    }

    #[test]
    fn runtime_effect_success_requires_restore_session_persistence() {
        let success = CoreEffectResult {
            effect_id: "effect-a".to_owned(),
            operation_id: "operation-a".to_owned(),
            ok: true,
            value_json: Some("{}".to_owned()),
            error: None,
        };
        let failed =
            finalize_persisted_effect_result(success.clone(), true, Some("disk full".to_owned()));
        assert!(!failed.ok);
        assert!(failed.value_json.is_none());
        assert_eq!(
            failed.error.as_ref().map(|error| error.code.as_str()),
            Some("SYSTEM_RUNTIME_PERSIST_FAILED")
        );

        assert!(finalize_persisted_effect_result(success.clone(), true, None).ok);
        assert!(finalize_persisted_effect_result(success, false, Some("ignored".to_owned())).ok);
    }

    #[test]
    fn minimized_and_zero_sized_windows_do_not_relayout_game_surfaces() {
        for (width, height, minimized, expected) in [
            (1280, 720, false, true),
            (0, 720, false, false),
            (1280, 0, false, false),
            (1280, 720, true, false),
        ] {
            assert_eq!(
                runtime_window_resize_is_actionable(width, height, minimized),
                expected,
                "{width}x{height}, minimized={minimized}"
            );
        }
    }

    #[test]
    fn surface_release_barrier_is_platform_explicit() {
        for (
            platform,
            controller_released,
            native_surface_released,
            browser_process_exited,
            expected,
        ) in [
            ("macos", false, false, false, false),
            ("macos", true, false, false, false),
            ("macos", true, true, false, true),
            ("windows", false, true, true, false),
            ("windows", true, false, true, false),
            ("windows", true, true, false, true),
            ("windows", true, true, true, true),
        ] {
            assert_eq!(
                surface_release_complete(
                    platform,
                    &SurfaceReleaseState {
                        browser_process_exited,
                        controller_released,
                        isolated: native_surface_released,
                        native_surface_released,
                    }
                ),
                expected,
                "{platform}: controller={controller_released}, native={native_surface_released}, browser={browser_process_exited}"
            );
        }
    }

    #[test]
    fn managed_surfaces_close_role_pages_before_dividers() {
        assert!(
            managed_surface_close_priority(ManagedSurfaceKind::Popup)
                < managed_surface_close_priority(ManagedSurfaceKind::Recovery)
        );
        assert!(
            managed_surface_close_priority(ManagedSurfaceKind::Recovery)
                < managed_surface_close_priority(ManagedSurfaceKind::Role)
        );
        assert!(
            managed_surface_close_priority(ManagedSurfaceKind::Role)
                < managed_surface_close_priority(ManagedSurfaceKind::Divider)
        );
    }

    #[test]
    fn close_presentation_selects_right_then_left_without_reopening_the_closed_tab() {
        let ids = ["a", "b", "c", "d"].map(str::to_owned);
        assert_eq!(
            successor_tab_after_close(&ids, "a", |_| true).as_deref(),
            Some("b")
        );
        assert_eq!(
            successor_tab_after_close(&ids, "b", |_| true).as_deref(),
            Some("c")
        );
        assert_eq!(
            successor_tab_after_close(&ids, "d", |_| true).as_deref(),
            Some("c")
        );
        assert_eq!(
            successor_tab_after_close(&ids, "b", |candidate| candidate == "a").as_deref(),
            Some("a")
        );
        assert_eq!(successor_tab_after_close(&ids[..1], "a", |_| true), None);
    }

    #[test]
    fn close_intent_builds_core_command_without_a_runtime_snapshot() {
        let role = RuntimeTabCloseIntent {
            source_id: "role-a".to_owned(),
            tab_type: "role".to_owned(),
        };
        assert!(matches!(
            role.into_core_command(),
            CoreCommand::BrowserRoleStop { role_id } if role_id == "role-a"
        ));

        let workspace = RuntimeTabCloseIntent {
            source_id: "workspace-a".to_owned(),
            tab_type: "workspace".to_owned(),
        };
        assert!(matches!(
            workspace.into_core_command(),
            CoreCommand::BrowserWorkspaceStop { workspace_id }
                if workspace_id == "workspace-a"
        ));
    }

    #[test]
    fn presentation_barrier_waits_for_the_applied_revision_and_is_bounded() {
        let actor = Arc::new(NativeWindowActor {
            queue: Arc::new((
                Mutex::new(NativeWindowActorState::default()),
                Condvar::new(),
            )),
        });
        let completing_actor = Arc::clone(&actor);
        let completion = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            let (lock, changed) = &*completing_actor.queue;
            let mut state = lock.lock().unwrap();
            state.applied_revision = 7;
            changed.notify_all();
        });

        assert!(actor.wait_until_applied(7, Duration::from_millis(100)));
        completion.join().unwrap();
        assert!(!actor.wait_until_applied(8, Duration::from_millis(1)));
    }

    fn presentation_tab(id: &str, phase: TabPresentationPhase) -> TabPresentation {
        TabPresentation {
            closable: true,
            icon_data_url: None,
            id: id.to_owned(),
            phase,
            source_id: format!("source-{id}"),
            tab_type: "role".to_owned(),
            title: format!("Tab {id}"),
            #[cfg(target_os = "macos")]
            workspace_template: None,
        }
    }

    #[test]
    fn presentation_selection_is_independent_from_launch_phase_and_core_metadata() {
        let mut state = WindowPresentationState::default();
        state.insert_tab(
            presentation_tab("tab-a", TabPresentationPhase::Ready),
            1,
            true,
        );
        state.insert_tab(
            presentation_tab("preview-b", TabPresentationPhase::Reserved),
            2,
            true,
        );

        state.update_metadata("tab-a", "role-a", "role", "Updated A");
        state.update_phase("preview-b", TabPresentationPhase::Loading);
        state.reorder_known_tabs(&["tab-a".to_owned()]);

        assert_eq!(state.selected_tab_id.as_deref(), Some("preview-b"));
        assert!(state.contains_tab("preview-b"));
        assert_eq!(state.revision, 2);

        state.replace_tab_id(
            "preview-b",
            presentation_tab("tab-b", TabPresentationPhase::Attaching),
            3,
        );
        assert_eq!(state.selected_tab_id.as_deref(), Some("tab-b"));
        assert_eq!(
            state.aliases.get("preview-b").map(String::as_str),
            Some("tab-b")
        );

        state.update_phase("tab-b", TabPresentationPhase::Failed);
        state.select(Some("tab-b".to_owned()), 4);
        assert_eq!(state.selected_tab_id.as_deref(), Some("tab-b"));
        assert!(state.host_visibility);
    }

    #[test]
    fn moving_a_selected_presentation_tab_commits_both_windows_without_core_state() {
        let registry = PresentationRegistry::default();
        let source = registry.coordinator("window-a").unwrap();
        {
            let mut source = source.lock().unwrap();
            source.insert_tab(
                presentation_tab("tab-a", TabPresentationPhase::Ready),
                1,
                false,
            );
            source.insert_tab(
                presentation_tab("tab-b", TabPresentationPhase::Loading),
                2,
                true,
            );
        }

        registry
            .move_tab("tab-b", "window-a", "window-b", 3)
            .unwrap();

        let source = registry.existing("window-a").unwrap();
        let source = source.lock().unwrap();
        assert_eq!(source.selected_tab_id.as_deref(), Some("tab-a"));
        assert!(!source.contains_tab("tab-b"));
        drop(source);
        let target = registry.existing("window-b").unwrap();
        let target = target.lock().unwrap();
        assert_eq!(target.selected_tab_id.as_deref(), Some("tab-b"));
        assert!(target.contains_tab("tab-b"));
    }

    #[test]
    fn only_unisolated_surface_phases_block_role_relaunch() {
        for phase in [
            ManagedSurfacePhase::Live,
            ManagedSurfacePhase::CloseRequested,
            ManagedSurfacePhase::Isolating,
            ManagedSurfacePhase::Provisional,
            ManagedSurfacePhase::Quarantined,
        ] {
            assert!(phase.blocks_role_relaunch(), "{phase:?}");
        }
        for phase in [
            ManagedSurfacePhase::Isolated,
            ManagedSurfacePhase::Releasing,
            ManagedSurfacePhase::Released,
            ManagedSurfacePhase::Retired,
        ] {
            assert!(!phase.blocks_role_relaunch(), "{phase:?}");
        }
    }

    #[test]
    fn native_window_actor_bounds_and_coalesces_pending_presentation_work() {
        let mut queue = LatestOnlyPresentationQueue::default();
        for revision in 1..=20 {
            queue.replace(revision);
        }
        assert_eq!(queue.begin_latest(), Some(20));
        assert!(queue.in_flight);
        assert!(queue.pending.is_none());

        for revision in 21..=40 {
            queue.replace(revision);
        }
        assert_eq!(queue.begin_latest(), None);
        assert_eq!(queue.pending, Some(40));
        queue.finish();
        assert_eq!(queue.begin_latest(), Some(40));
        queue.finish();
        assert!(!queue.in_flight);
        assert!(queue.pending.is_none());
    }

    #[test]
    fn returning_to_the_applied_tab_skips_native_visibility_and_focus_work() {
        let tab = Some("tab-a".to_owned());
        let labels = HashSet::from(["surface-a:7".to_owned(), "divider-a:8".to_owned()]);
        assert!(!native_presentation_changed(&tab, &tab, &labels, &labels));

        let replacement = HashSet::from(["surface-a:9".to_owned(), "divider-a:8".to_owned()]);
        assert!(native_presentation_changed(
            &tab,
            &tab,
            &labels,
            &replacement
        ));
        assert!(native_presentation_changed(
            &tab,
            &Some("tab-b".to_owned()),
            &labels,
            &labels
        ));
    }

    #[test]
    fn provisional_aliases_resolve_to_the_attached_runtime_tab() {
        let registry = PresentationRegistry::default();
        let coordinator = registry.coordinator("window-a").unwrap();
        coordinator
            .lock()
            .unwrap()
            .aliases
            .insert("provisional-a".to_owned(), "runtime-a".to_owned());
        assert_eq!(
            registry.resolve_tab_alias("provisional-a").as_deref(),
            Some("runtime-a")
        );
        assert_eq!(registry.resolve_tab_alias("unknown"), None);
    }

    #[test]
    fn launcher_source_lookup_uses_presentation_without_runtime_or_page_readiness() {
        let registry = PresentationRegistry::default();
        let coordinator = registry.coordinator("window-a").unwrap();
        {
            let mut state = coordinator.lock().unwrap();
            state.insert_tab(
                TabPresentation {
                    closable: true,
                    icon_data_url: None,
                    id: "provisional-a".to_owned(),
                    phase: TabPresentationPhase::Reserved,
                    source_id: "role-a".to_owned(),
                    tab_type: "role".to_owned(),
                    title: "Loading".to_owned(),
                    #[cfg(target_os = "macos")]
                    workspace_template: None,
                },
                1,
                true,
            );
        }
        assert_eq!(
            registry.tab_for_source("role-a", "role").as_deref(),
            Some("provisional-a")
        );
        assert_eq!(registry.tab_for_source("role-a", "workspace"), None);

        coordinator.lock().unwrap().replace_tab_id(
            "provisional-a",
            TabPresentation {
                closable: true,
                icon_data_url: None,
                id: "runtime-a".to_owned(),
                phase: TabPresentationPhase::Attaching,
                source_id: "role-a".to_owned(),
                tab_type: "role".to_owned(),
                title: "Role A".to_owned(),
                #[cfg(target_os = "macos")]
                workspace_template: None,
            },
            2,
        );
        assert_eq!(
            registry.tab_for_source("role-a", "role").as_deref(),
            Some("runtime-a")
        );
    }

    #[test]
    fn optional_native_work_waits_for_every_essential_launch_phase() {
        assert!(LaunchPhase::Attaching.blocks_optional_idle());
        assert!(LaunchPhase::Navigating.blocks_optional_idle());
        for phase in [
            LaunchPhase::EssentialReady,
            LaunchPhase::OptionalHydrating,
            LaunchPhase::Ready,
            LaunchPhase::Degraded,
        ] {
            assert!(!phase.blocks_optional_idle(), "{phase:?}");
        }
    }

    #[test]
    fn close_and_tab_launch_effects_leave_the_global_effect_fifo() {
        assert!(is_surface_close_effect(
            &CoreEffectAction::EmbeddedDestroyRole {
                role_id: "role-a".to_owned()
            }
        ));
        assert!(is_surface_close_effect(
            &CoreEffectAction::EmbeddedDestroyTab {
                tab_id: "tab-a".to_owned(),
                next_active_tab_id: None
            }
        ));
        assert!(!is_surface_close_effect(
            &CoreEffectAction::EmbeddedFocusRole {
                role_id: "role-a".to_owned(),
                zoom_factor: None
            }
        ));
        assert!(is_independent_tab_launch_effect(
            &CoreEffectAction::EmbeddedLoadRoles { roles: Vec::new() }
        ));
        assert!(is_independent_tab_launch_effect(
            &CoreEffectAction::EmbeddedInstallOverlays {
                role_ids: Vec::new()
            }
        ));
        assert!(!is_independent_tab_launch_effect(
            &CoreEffectAction::EmbeddedApplyRuntime {
                snapshot: BrowserRuntimeSnapshot {
                    windows: Vec::new(),
                    roles: Vec::new(),
                    tabs: Vec::new(),
                    workspaces: Vec::new(),
                },
                target: None,
                reveal_window_ids: Vec::new(),
                focus_window_ids: Vec::new(),
                focus_tab_id: None,
            }
        ));
    }

    #[test]
    fn windows_surface_close_mock_rejects_the_wrong_controller_or_process() {
        assert!(windows_surface_identity_matches(41, 41, 700, 700));
        assert!(!windows_surface_identity_matches(41, 42, 700, 700));
        assert!(!windows_surface_identity_matches(41, 41, 700, 701));
        assert!(!windows_surface_identity_matches(0, 0, 700, 700));
        assert!(!windows_surface_identity_matches(41, 41, 0, 0));
    }

    #[test]
    fn surface_release_barrier_has_a_bounded_timeout() {
        let tracker = SurfaceLifecycleTracker::default();
        let started = Instant::now();
        assert!(!tracker.wait_for_controller_release("windows", Duration::from_millis(5)));
        assert!(started.elapsed() < Duration::from_secs(1));

        tracker.mark_controller_released();
        assert!(!tracker.wait_for_controller_release("macos", Duration::from_millis(5)));
        tracker.mark_native_surface_released();
        assert!(tracker.wait_for_controller_release("macos", Duration::from_millis(5)));

        #[cfg(windows)]
        {
            assert!(tracker.wait_for_controller_release("windows", Duration::from_millis(5)));
            assert!(!tracker.wait_for_browser_process_exit(Duration::from_millis(5)));
            tracker.mark_browser_process_exited();
            assert!(tracker.wait_for_browser_process_exit(Duration::from_millis(5)));
        }
    }

    #[test]
    fn unhealthy_runtime_fails_closed_for_future_lifecycle_mutations() {
        let health = RuntimeHealth::new();
        assert!(health.require_healthy().is_ok());
        health.mark_unhealthy();
        let error = health.require_healthy().unwrap_err();
        assert_eq!(error.code, "SYSTEM_WEBVIEW_RUNTIME_UNHEALTHY");
    }

    #[test]
    fn recovery_callbacks_are_coalesced_and_fenced_by_generation() {
        let mut recovering_roles = HashSet::new();
        assert!(claim_surface_recovery(
            7,
            7,
            &mut recovering_roles,
            "role-a"
        ));
        assert!(!claim_surface_recovery(
            7,
            7,
            &mut recovering_roles,
            "role-a"
        ));
        assert!(!claim_surface_recovery(
            7,
            6,
            &mut recovering_roles,
            "role-b"
        ));
        assert!(!claim_surface_recovery(
            7,
            8,
            &mut recovering_roles,
            "role-c"
        ));
    }

    #[test]
    fn native_isolation_wait_observes_the_exact_lease_callback() {
        let tracker = Arc::new(SurfaceLifecycleTracker::default());
        let callback_tracker = Arc::clone(&tracker);
        let worker = std::thread::spawn(move || callback_tracker.mark_isolated());
        assert!(tracker.wait_for_isolation(Duration::from_millis(100)));
        worker.join().unwrap();
    }

    #[test]
    fn native_isolation_wait_is_bounded_without_polling() {
        let tracker = SurfaceLifecycleTracker::default();
        let started = Instant::now();
        assert!(!tracker.wait_for_isolation(Duration::from_millis(5)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn recovery_swap_requires_the_original_surface_and_generation() {
        assert!(surface_recovery_swap_is_current(
            "role-surface-a",
            "role-surface-a",
            7,
            7
        ));
        assert!(!surface_recovery_swap_is_current(
            "role-surface-b",
            "role-surface-a",
            7,
            7
        ));
        assert!(!surface_recovery_swap_is_current(
            "role-surface-a",
            "role-surface-a",
            8,
            7
        ));
    }

    #[test]
    fn close_commit_requires_the_same_authoritative_handle() {
        assert!(surface_close_commit_is_current(
            "tab-a",
            "tab-a",
            "surface-a",
            "surface-a"
        ));
        assert!(!surface_close_commit_is_current(
            "tab-b",
            "tab-a",
            "surface-a",
            "surface-a"
        ));
        assert!(!surface_close_commit_is_current(
            "tab-a",
            "tab-a",
            "surface-b",
            "surface-a"
        ));
    }

    #[test]
    fn provisional_move_surfaces_incomplete_compensation() {
        let original = "second surface hide failed".to_owned();
        assert_eq!(
            provisional_move_failure_message(original.clone(), &[]),
            original
        );
        let message = provisional_move_failure_message(
            "reparent failed".to_owned(),
            &[
                "reparent role-b: denied".to_owned(),
                "layout: stale".to_owned(),
            ],
        );
        assert!(message.starts_with("SYSTEM_PROVISIONAL_MOVE_ROLLBACK_FAILED"));
        assert!(message.contains("reparent role-b: denied"));
        assert!(message.contains("Restart Rion Studio"));
    }

    #[test]
    fn popup_renderer_failure_is_isolated_from_role_recovery() {
        let popup = SurfaceFailureTarget::Popup {
            label: "popup-a".to_owned(),
            role_id: "role-a".to_owned(),
            generation: 7,
        };
        let role = SurfaceFailureTarget::Role {
            role_id: "role-a".to_owned(),
            generation: 7,
        };

        assert_eq!(
            surface_failure_action(&popup, SurfaceFailureScope::Renderer),
            SurfaceFailureAction::ClosePopup
        );
        assert_eq!(
            surface_failure_action(&popup, SurfaceFailureScope::Browser),
            SurfaceFailureAction::RecoverRole
        );
        assert_eq!(
            surface_failure_action(&role, SurfaceFailureScope::Renderer),
            SurfaceFailureAction::RecoverRole
        );
    }

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
            generation: 1,
            keys: vec!["game_client_settings".to_owned()],
            origin: "https://example.test".to_owned(),
            source_role_id: None,
            token: "capability".to_owned(),
        };
        let observer = local_storage_sync_observer_script(&config).unwrap();
        assert!(observer.contains("globalThis.top !== globalThis"));
        assert!(observer.contains("location.origin !== state.origin"));
        assert!(observer.contains("rion_local_storage_sync_changed"));
        assert!(observer.contains("state.inFlight = request"));
        assert!(observer.contains("state.queued = serialized === state.inFlight.serialized"));
        assert!(observer.contains("generation: request.generation"));
        assert!(observer.contains("sequence: request.sequence"));
        assert!(observer.contains("setInterval(schedule, 250)"));
        assert!(observer.contains("setTimeout(publish, 100)"));
        assert!(observer.contains("storagePrototype.setItem"));
        assert!(observer.contains("storagePrototype.removeItem"));
        assert!(observer.contains("storagePrototype.clear"));
        assert!(observer.contains("disable(expectedToken)"));
        assert!(observer.contains("state.keys = []"));

        let configure = local_storage_sync_configure_script(&config).unwrap();
        assert!(configure.contains("__rionLocalStorageSyncObserver?.configure?."));
        assert!(configure.contains("\"generation\":1"));
        let disable = local_storage_sync_disable_script("capability").unwrap();
        assert_eq!(
            disable,
            "globalThis.__rionLocalStorageSyncObserver?.disable?.(\"capability\");"
        );

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
    fn local_storage_sync_sequence_fences_duplicates_and_out_of_order_callbacks() {
        let mut last_accepted = 0;
        assert!(accept_local_storage_sync_sequence(&mut last_accepted, 2));
        assert!(!accept_local_storage_sync_sequence(&mut last_accepted, 1));
        assert!(!accept_local_storage_sync_sequence(&mut last_accepted, 2));
        assert!(!accept_local_storage_sync_sequence(&mut last_accepted, 0));
        assert!(accept_local_storage_sync_sequence(&mut last_accepted, 3));
        assert_eq!(last_accepted, 3);
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
    fn runtime_tab_reload_attempts_every_role_surface_and_reports_the_first_error() {
        let mut attempted = Vec::new();
        let error = reload_runtime_tab_handles(["role-a", "destroyed", "role-b"], |label| {
            attempted.push(label);
            if label == "destroyed" {
                Err("WebView was destroyed")
            } else {
                Ok(())
            }
        })
        .unwrap_err();

        assert_eq!(attempted, ["role-a", "destroyed", "role-b"]);
        assert_eq!(error, "WebView was destroyed");

        let mut single_attempt = Vec::new();
        reload_runtime_tab_handles(["role-only"], |label| {
            single_attempt.push(label);
            Ok::<_, &str>(())
        })
        .unwrap();
        assert_eq!(single_attempt, ["role-only"]);
    }

    #[test]
    fn macro_release_is_limited_to_top_level_game_page_navigation_schemes() {
        for url in ["https://game.example/", "http://game.example/"] {
            assert!(should_release_macros_for_navigation(
                &Url::parse(url).unwrap()
            ));
        }
        for url in ["about:blank", "data:text/plain,internal"] {
            assert!(!should_release_macros_for_navigation(
                &Url::parse(url).unwrap()
            ));
        }
    }

    #[test]
    fn windows_document_requests_are_deferred_except_during_controlled_navigation() {
        assert!(should_defer_document_navigation("windows", false));
        assert!(!should_defer_document_navigation("windows", true));
    }

    #[test]
    fn macos_and_other_platforms_preserve_document_requests_without_deferral() {
        assert!(!should_defer_document_navigation("macos", false));
        assert!(!should_defer_document_navigation("other", false));
    }

    #[test]
    fn navigation_deferral_completion_is_exactly_once_after_success() {
        let completed = AtomicBool::new(false);
        let attempts = AtomicU64::new(0);

        assert_eq!(
            complete_navigation_deferral_once(&completed, || {
                attempts.fetch_add(1, Ordering::Relaxed);
                Ok::<_, ()>(())
            }),
            Ok(true)
        );
        assert_eq!(
            complete_navigation_deferral_once(&completed, || {
                attempts.fetch_add(1, Ordering::Relaxed);
                Ok::<_, ()>(())
            }),
            Ok(false)
        );
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn navigation_deferral_completion_is_exactly_once_after_failure() {
        let completed = AtomicBool::new(false);
        let attempts = AtomicU64::new(0);

        assert_eq!(
            complete_navigation_deferral_once(&completed, || {
                attempts.fetch_add(1, Ordering::Relaxed);
                Err::<(), _>("complete failed")
            }),
            Err("complete failed")
        );
        assert_eq!(
            complete_navigation_deferral_once(&completed, || {
                attempts.fetch_add(1, Ordering::Relaxed);
                Ok::<_, &str>(())
            }),
            Ok(false)
        );
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
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

    #[tokio::test]
    async fn navigation_tracker_async_wait_does_not_require_a_blocking_worker() {
        let tracker = Arc::new(NavigationTracker::default());
        tracker.reset();
        let waiting = Arc::clone(&tracker);
        let waiter = tokio::spawn(async move { waiting.wait_async().await });
        tokio::task::yield_now().await;
        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/ready").unwrap(),
        );
        assert!(waiter.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn navigation_tracker_retains_completion_before_async_subscription() {
        let tracker = NavigationTracker::default();
        tracker.reset();
        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/already-ready").unwrap(),
        );
        assert!(tracker.wait_async().await.is_ok());
    }

    #[test]
    fn native_creation_gate_never_exceeds_its_global_limit() {
        let gate = Arc::new(NativeCreationGate::new(2));
        let active = Arc::new(AtomicU64::new(0));
        let maximum = Arc::new(AtomicU64::new(0));
        let threads = (0..8)
            .map(|_| {
                let gate = Arc::clone(&gate);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                std::thread::spawn(move || {
                    let _permit = gate.acquire().unwrap();
                    let current = active.fetch_add(1, Ordering::AcqRel) + 1;
                    maximum.fetch_max(current, Ordering::AcqRel);
                    std::thread::sleep(Duration::from_millis(5));
                    active.fetch_sub(1, Ordering::AcqRel);
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(active.load(Ordering::Acquire), 0);
        assert!(maximum.load(Ordering::Acquire) <= 2);
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_high_refresh_rate_finds_only_the_expected_webkit_feature() {
        unsafe extern "C" {
            fn rion_wk_high_refresh_rate_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_high_refresh_rate_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_surface_leases_keep_exact_webviews_isolated() {
        unsafe extern "C" {
            fn rion_wk_surface_lifecycle_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_surface_lifecycle_self_test() });
    }

    #[test]
    fn performance_diagnostic_probe_is_foreground_scoped_and_privacy_bounded() {
        assert!(PERFORMANCE_DIAGNOSTIC_START_SOURCE.contains("requestAnimationFrame(tick)"));
        assert!(PERFORMANCE_DIAGNOSTIC_START_SOURCE.contains("PerformanceObserver"));
        assert!(PERFORMANCE_DIAGNOSTIC_START_SOURCE.contains("longtask"));
        assert!(PERFORMANCE_DIAGNOSTIC_READ_SOURCE.contains("takeRecords"));
        assert!(PERFORMANCE_DIAGNOSTIC_READ_SOURCE.contains("document.visibilityState"));
        assert!(PERFORMANCE_DIAGNOSTIC_READ_SOURCE.contains("document.hasFocus()"));
        assert!(PERFORMANCE_DIAGNOSTIC_READ_SOURCE.contains("intervals.length * 1000"));
        assert!(PERFORMANCE_DIAGNOSTIC_READ_SOURCE.contains("failIfMajorPerformanceCaveat: true"));
        assert!(PERFORMANCE_DIAGNOSTIC_READ_SOURCE.contains("WEBGL_debug_renderer_info"));
        for source in [
            PERFORMANCE_DIAGNOSTIC_START_SOURCE,
            PERFORMANCE_DIAGNOSTIC_READ_SOURCE,
        ] {
            assert!(!source.contains("localStorage"));
            assert!(!source.contains("document.cookie"));
            assert!(!source.contains("location.href"));
        }
    }

    #[test]
    fn performance_diagnostic_readback_accepts_nested_webview_json() {
        let value = json!({
            "documentVisibilityState": "visible",
            "documentHasFocus": true,
            "viewportWidth": 1280.0,
            "viewportHeight": 720.0,
            "devicePixelRatio": 2.0,
            "hardwareConcurrency": 8,
            "frameCount": 188,
            "observedDurationMs": 1500.0,
            "averageFps": 125.3,
            "frameIntervalsMs": [8.0, 8.2, 17.0],
            "p50FrameIntervalMs": 8.0,
            "p95FrameIntervalMs": 8.4,
            "p99FrameIntervalMs": 16.0,
            "longestFrameIntervalMs": 16.1,
            "longTaskCount": 1,
            "longTaskTotalDurationMs": 62.0,
            "longestTaskMs": 62.0,
            "graphics": {
                "renderer": "Apple GPU",
                "vendor": "Apple",
                "webgl": "available",
                "webgl2": "available",
                "webgpu": "available"
            }
        });
        let nested = serde_json::to_string(&serde_json::to_string(&value).unwrap()).unwrap();
        let readback = decode_performance_diagnostic_readback(&nested).unwrap();
        assert_eq!(readback.document_visibility_state, "visible");
        assert!(readback.document_has_focus);
        assert_eq!(readback.frame_count, 188);
        assert_eq!(readback.average_fps, Some(125.3));
        assert_eq!(readback.frame_intervals_ms, vec![8.0, 8.2, 17.0]);
        assert_eq!(readback.p99_frame_interval_ms, Some(16.0));
        assert_eq!(readback.long_task_count, Some(1));
        assert_eq!(readback.graphics.renderer.as_deref(), Some("Apple GPU"));
    }

    #[test]
    fn performance_diagnostic_counts_slow_frames_against_explicit_refresh_rates() {
        for (refresh_rate, intervals, expected) in [
            (60.0, vec![16.7, 26.0, 34.0, 51.0], (Some(3), Some(6))),
            (120.0, vec![8.3, 13.0, 17.0, 26.0], (Some(3), Some(6))),
        ] {
            assert_eq!(
                frame_budget_diagnostics(&intervals, Some(refresh_rate)),
                expected
            );
        }
        assert_eq!(frame_budget_diagnostics(&[16.7], None), (None, None));
        assert_eq!(
            frame_budget_diagnostics(&[f64::NAN, -1.0, 16.0], Some(60.0)),
            (Some(0), Some(0))
        );
    }

    #[test]
    fn high_refresh_diagnostic_status_labels_are_stable() {
        for (status, expected) in [
            (HighRefreshRateDiagnosticStatus::Applied, "applied"),
            (HighRefreshRateDiagnosticStatus::Disabled, "disabled"),
            (HighRefreshRateDiagnosticStatus::Unavailable, "unavailable"),
            (HighRefreshRateDiagnosticStatus::Failed, "failed"),
            (HighRefreshRateDiagnosticStatus::Timeout, "timeout"),
            (
                HighRefreshRateDiagnosticStatus::ScheduleFailed,
                "schedule-failed",
            ),
            (
                HighRefreshRateDiagnosticStatus::NotApplicable,
                "not-applicable",
            ),
        ] {
            assert_eq!(high_refresh_rate_status_label(status), expected);
        }
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
    fn role_bounds_are_relative_to_the_host_work_area() {
        let target = EmbeddedLaunchTargetRecord {
            window_id: "window-7".to_owned(),
            display_id: 7,
            scale_factor: 2.0,
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
            let logical = logical_window_position(physical_x, physical_y, scale);
            assert_eq!(
                logical, expected,
                "unexpected logical position on {platform}"
            );
            assert_eq!(
                physical_window_position(logical.0, logical.1, scale),
                (physical_x, physical_y),
                "unexpected restored physical position on {platform}"
            );
        }
        assert_eq!(physical_window_position(120, -40, f64::NAN), (120, -40));
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
    fn matching_fullscreen_runtime_targets_preserve_native_window_presentation() {
        for (platform, fullscreen, presentation, expected) in [
            ("macos", true, "fullscreen", false),
            ("windows", true, "fullscreen", false),
            ("macos", false, "fullscreen", true),
            ("windows", false, "fullscreen", true),
            ("macos", true, "normal", true),
            ("windows", true, "normal", true),
            ("macos", true, "maximized", true),
            ("windows", true, "maximized", true),
        ] {
            assert_eq!(
                runtime_target_requires_placement_reapply(presentation, fullscreen),
                expected,
                "unexpected placement policy on {platform}: fullscreen={fullscreen}, presentation={presentation}"
            );
        }
    }

    #[test]
    fn surface_host_initialization_requires_a_visible_parent_only_on_windows() {
        for (platform, expected) in [("windows", true), ("macos", false), ("linux", false)] {
            assert_eq!(
                surface_host_initialization_requires_visible_parent(platform),
                expected,
                "unexpected parent-window initialization policy on {platform}"
            );
        }
    }

    #[test]
    fn native_font_script_loads_current_settings_through_the_role_bound_bridge() {
        let source = native_font_document_start_script();
        assert!(source.contains("rion_browser_font_payload"));
        assert!(source.contains("rion-studio-browser-fonts"));
        assert!(source.contains("FontFace"));
        assert!(source.contains("CanvasRenderingContext2D"));
        assert!(source.contains("OffscreenCanvasRenderingContext2D"));
        assert!(source.contains("fillText"));
        assert!(source.contains("measureText"));
        assert!(source.contains("textRendering"));
        assert!(source.contains("fontKerning"));
        assert!(source.contains("fontSmoothingEnabled"));
        assert!(source.contains("-webkit-font-smoothing"));
        assert!(source.contains("font-optical-sizing"));
        assert!(source.contains("!important"));
        assert!(source.contains("numeric"));
        assert!(source.contains("monospace"));
        assert!(!source.contains("fonts.googleapis.com"));
        assert!(!source.contains("WebGLRenderingContext"));
        assert!(!source.contains("imageSmoothingEnabled"));
    }

    #[test]
    fn shared_macro_overlay_builds_with_the_tauri_only_bridge() {
        let template = macro_overlay_document_start_script_template().unwrap();
        let source = macro_overlay_document_start_script(&template, "test-capability").unwrap();
        assert!(source.contains("rion_overlay_request"));
        assert!(source.contains("rion_overlay_ready"));
        assert!(source.contains("binding.ready"));
        assert!(source.contains("test-capability"));
        assert!(source.contains("event.isTrusted === true"));
        assert!(source.contains("rion-studio-macro-overlay-v57"));
        assert!(source.contains("const overlayCss = \"/*"));
        assert!(source.contains("--font-ui: system-ui"));
        assert!(source.contains("*{box-sizing:border-box;font-family:var(--font-ui)"));
        assert!(source.contains("@media (prefers-reduced-motion:reduce)"));
        assert!(!source.contains(MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_BINDING_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_CAPABILITY_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_TRUSTED_EVENT_GUARD_TOKEN));
        assert!(!source.contains(MACRO_OVERLAY_CSS_TOKEN));
        assert!(!source.contains("globalThis.rionStudioMacroOverlay"));
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

    #[test]
    fn windows_application_shortcuts_cover_discrete_commands_and_repeats() {
        use crate::application_menu::ApplicationShortcutCommand;

        assert_eq!(
            windows_application_shortcut_command(0x4E, true, false, false, false, false),
            Some(ApplicationShortcutCommand::NewGameWindow)
        );
        assert_eq!(
            windows_application_shortcut_command(0x7A, false, false, false, false, false),
            Some(ApplicationShortcutCommand::ToggleFullscreen)
        );
        assert_eq!(
            windows_application_shortcut_command(0xBB, true, false, false, true, true),
            Some(ApplicationShortcutCommand::ZoomIn)
        );
        assert_eq!(
            windows_application_shortcut_command(0x4E, true, false, false, false, true),
            None
        );
        assert_eq!(
            windows_application_shortcut_command(0x7A, false, false, false, false, true),
            None
        );
        assert_eq!(
            windows_application_shortcut_command(0x7A, false, true, false, false, false),
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_role_zoom_shortcut_responder_consumes_only_supported_combinations() {
        unsafe extern "C" {
            fn rion_wk_role_zoom_shortcut_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_role_zoom_shortcut_self_test() });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_background_input_preserves_the_foreground_responder() {
        unsafe extern "C" {
            fn rion_wk_background_input_focus_self_test() -> bool;
        }
        assert!(unsafe { rion_wk_background_input_focus_self_test() });
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

    #[test]
    fn private_session_files_are_published_atomically() {
        let root = tempfile::tempdir().unwrap();
        let transaction = root.path().join("transaction");
        write_private_file(&transaction, "committed", b"complete").unwrap();
        assert_eq!(
            fs::read(transaction.join("committed")).unwrap(),
            b"complete"
        );

        fs::remove_file(transaction.join("committed")).unwrap();
        fs::create_dir(transaction.join("committed")).unwrap();
        assert!(write_private_file(&transaction, "committed", b"partial").is_err());
        assert!(transaction.join("committed").is_dir());
        assert!(
            fs::read_dir(&transaction)
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp"))
        );
    }
}
