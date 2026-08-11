use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, OnceLock, RwLock, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::watch;

use crate::native_projection::RevisionedJsonProjection;

use rion_core::{
    AppCore, ApplicationLifecycleStatusRecord, BrowserAction, BrowserActionRequest,
    BrowserLaunchCompletionRecord, BrowserRuntimeRoleOwnerRecord, BrowserRuntimeRoleRecord,
    BrowserRuntimeTabRecord, BrowserRuntimeWorkspaceRecord,
    BrowserPerformanceDiagnosticStatus, BrowserPerformanceDiagnosticsRecord,
    BrowserPerformanceSurfaceDiagnosticRecord, BrowserRuntimeSnapshot, BrowserRuntimeWindowRecord,
    CoreAppSnapshotRecord, CoreCommand, CoreEffectAction, CoreEffectDispatchReport,
    CoreEffectRequest, CoreEffectResult,
    DisplayTargetRecord,
    EmbeddedKeyEffectRecord, EmbeddedKeyTransitionRecord, EmbeddedLaunchTargetRecord,
    EmbeddedRoleLoadEffectRecord, EmbeddedRoleSlotEffectRecord, EmbeddedTabEffectRecord,
    EngineCapabilitySnapshotRecord,
    EngineCapabilityEvidenceRecord, EngineCapabilityStatus,
    GameWindowPlacementRecord, GameWindowRuntimeSnapshotBatchCommitInputRecord,
    GameWindowRuntimeSnapshotCommitInputRecord,
    GameWindowRoleSlotRecord, GameWindowSaveRuntimeInputRecord,
    GameWindowTabRecord,
    HighRefreshRateDiagnosticStatus, LayoutBounds, LayoutDividerInput,
    LayoutRect, LayoutRoleInput, LogCaptureRecord, LogErrorDetails, LogLevel, LogSource,
    MacroCoordinateContextRecord, MacroInputDiagnosticsRecord,
    OperationCompletionPolicy,
    RuntimeTabMutationRequestRecord,
    RuntimeWindowStopRequestRecord,
    ResolvedBrowserEngine, RuntimeRestoreSessionRecord, RuntimeRestoreTabRecord,
    RuntimeRestoreWindowRecord, RuntimeRoleSlotRecord, SessionCookieRecord,
    SessionTransferPayloadRecord, StateGameRecord,
    StateGameWindowRecord, StateNormalizedRectRecord, StatePixelBoundsRecord, StateRoleRecord,
    StateWebGraphicsRecord, SystemRuntimeDiagnosticsRecord, SystemRuntimeFailureRecord,
    SystemRuntimeInputFenceEventRecord, SystemRuntimeInputFenceRecord,
    SystemRuntimeOperationCompletionScope, SystemRuntimeOperationStatus,
    SystemRuntimeOperationSubsystem, SystemRuntimeOperationSummaryRecord, NativeWindowStateRecord,
    SurfaceRecoveryAttemptRecord,
    RuntimeWindowTabSnapshotRecord,
    LaunchAttemptId, NativeRuntimeEvent, OperationId, RuntimeCommitStatus, RuntimeIntent,
    RuntimeKernel,
    RuntimeLiveTabRecord as LiveTabRecord,
    RuntimeLiveWindowRecord as LiveWindowRecord,
    RuntimeNativeProjection, RuntimeOperationPhase, RuntimeSnapshot, RuntimeSurfaceGeneration,
    RuntimeTabActivationPhaseRecord, RuntimeTabId, RuntimeTabStatusIdentityRecord,
    RuntimeTopologyCommitInput as KernelTopologyCommitInput, RuntimeWindowGeneration,
    RuntimeWindowPlacementCommitInput as KernelWindowPlacementCommitInput,
    RuntimeWindowTopologyCommit as KernelWindowTopologyCommit, RuntimeWindowPreferencesRecord,
    SystemWebViewRuntimeRegistrationRecord,
    WorkspaceAppearanceSettingsRecord, WorkspaceDividerDescriptor, WorkspaceDividerResizeInput,
    WorkspaceLayoutInput,
};
#[cfg(any(windows, test))]
use rion_core::{
    RuntimeTabChromeAcknowledgementRecord, RuntimeTabChromeProjectionRecord,
    RuntimeTabChromeReadyRecord, RuntimeTabIntentRecord,
};
#[cfg(windows)]
use rion_core::{DisplayInfoRecord, RuntimeTabChromeItemRecord};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Url, Webview,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    webview::{
        Cookie, DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder,
        cookie::{SameSite, time::OffsetDateTime},
    },
    window::WindowBuilder,
};
#[cfg(target_os = "macos")]
use {objc2::rc::Retained, objc2_web_kit::WKWebViewConfiguration};

const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(40);
const RION_STUDIO_APP_NAME: &str = "Rion Studio";
const DIVIDER_HIT_TARGET: f64 = 10.0;
#[cfg(windows)]
const WINDOWS_TAB_STRIP_HEIGHT: f64 = 40.0;
const PLATFORM_CALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
const SURFACE_RECLAMATION_TIMEOUT: Duration = Duration::from_secs(10);
const MAIN_WINDOW_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const MAIN_WINDOW_ACTOR_CAPACITY: usize = 64;
// Drag completion is gesture-owned and never expires while the pointer is
// held. This horizon only bounds diagnostics retained by the operation registry.
const TAB_DRAG_DIAGNOSTIC_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const TAB_MUTATION_OPERATION_TIMEOUT: Duration = Duration::from_secs(20);
const SURFACE_RECOVERY_OPERATION_TIMEOUT: Duration = Duration::from_secs(70);
const POWER_LIFECYCLE_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const NATIVE_PRESENTATION_COALESCE_INTERVAL: Duration = Duration::from_millis(8);
const PRESENTATION_PAINT_BARRIER_TIMEOUT: Duration = Duration::from_millis(50);
#[cfg(windows)]
const WINDOWS_TAB_CHROME_ACK_TIMEOUT: Duration = Duration::from_secs(2);
const OPTIONAL_HYDRATION_IDLE_INTERVAL: Duration = Duration::from_millis(500);
const SURFACE_RECOVERY_LIMIT: u8 = 2;
const SURFACE_RECOVERY_WINDOW: Duration = Duration::from_secs(60);
const WINDOWS_ROLE_SETUP_RETRY_DELAY: Duration = Duration::from_millis(500);
#[cfg(target_os = "macos")]
const MACOS_KEY_DISPATCH_SETTLE_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(target_os = "macos")]
static MACOS_KEY_DISPATCH_STATE: std::sync::OnceLock<Mutex<Option<String>>> =
    std::sync::OnceLock::new();
#[cfg(target_os = "macos")]
const MACOS_MOUSE_DISPATCH_SETTLE_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(target_os = "macos")]
const MACOS_MOUSE_PRESS_INTERVAL: Duration = Duration::from_millis(2);
#[cfg(target_os = "macos")]
static MACOS_MOUSE_DISPATCH_STATE: std::sync::OnceLock<Mutex<Option<String>>> =
    std::sync::OnceLock::new();
static POPUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static DISPLAY_HOST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static SURFACE_INSTANCE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static ROLE_ZOOM_PERSIST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static ROLE_INPUT_WORKER_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[cfg(not(windows))]
static WINDOW_RESIZE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WINDOW_GENERATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[cfg(not(windows))]
static WINDOW_PLACEMENT_OBSERVATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WINDOW_RETIREMENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[cfg(windows)]
static WINDOWS_TAB_CHROME_REVISION: AtomicU64 = AtomicU64::new(1);
#[cfg(windows)]
static WINDOWS_LIVE_RESIZE_PLAN_REVISION: AtomicU64 = AtomicU64::new(1);

fn point_in_runtime_tab_control_row(
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    screen_x: f64,
    screen_y: f64,
) -> bool {
    screen_x >= left && screen_x < left + width && screen_y >= top && screen_y < top + height
}
#[cfg(not(windows))]
const WINDOW_RESIZE_LAYOUT_SETTLE_DEBOUNCE: Duration = Duration::from_millis(180);
#[cfg(not(windows))]
const WINDOW_RESIZE_FRAME_INTERVAL: Duration = Duration::from_millis(50);
const WINDOW_STATE_PERSIST_DEBOUNCE: Duration = Duration::from_millis(200);
const DESIGN_TOKENS_CSS: &str = include_str!("../../../src/shared/designTokens.css");
const MACRO_OVERLAY_RUNTIME_SOURCE: &str = concat!(
    include_str!("../../../src/shared/browser-overlay/macro-overlay-runtime/state-and-input.js"),
    include_str!(
        "../../../src/shared/browser-overlay/macro-overlay-runtime/keyboard-input-guard.js"
    ),
    include_str!(
        "../../../src/shared/browser-overlay/macro-overlay-runtime/presentation-and-lifecycle.js"
    )
);
const MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE: &str =
    include_str!("../../../src/shared/browser-overlay/macroCoordinateMeasurement.js");
const MACRO_OVERLAY_CSS: &str = include_str!("../../../src/shared/browser-overlay/macroOverlay.css");
const MACRO_OVERLAY_SHORTCUT_GUARD_SOURCE: &str =
    include_str!("../../../src/shared/browser-overlay/macroOverlayShortcutGuard.js");
const MACRO_OVERLAY_BINDING_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_BINDING__";
const MACRO_OVERLAY_CAPABILITY_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_CAPABILITY__";
const MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__";
const MACRO_OVERLAY_TRUSTED_EVENT_GUARD_TOKEN: &str =
    "__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__";
const MACRO_OVERLAY_TRUSTED_EVENT_GUARD_SOURCE: &str = "(event) => event.isTrusted === true";
const MACRO_OVERLAY_CSS_TOKEN: &str = "__RION_STUDIO_MACRO_OVERLAY_CSS__";
const MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE_TOKEN: &str =
    "__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE__";
const MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER_TOKEN: &str =
    "__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER__";
const MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER_SOURCE: &str =
    "(moduleUrl) => import(moduleUrl)";
const MACRO_OVERLAY_REFRESH_SOURCE: &str = "void globalThis.__rionStudioMacroOverlay?.refresh?.()";
const RUNTIME_INDICATOR_RUNTIME_SOURCE: &str =
    include_str!("../../../src/shared/browser-overlay/runtimeIndicators.js");
const RUNTIME_INDICATOR_CSS: &str =
    include_str!("../../../src/shared/browser-overlay/runtimeIndicators.css");
const RUNTIME_INDICATOR_CSS_TOKEN: &str = "__RION_STUDIO_RUNTIME_INDICATOR_CSS__";
const BROWSER_FONTS_RUNTIME_SOURCE: &str =
    include_str!("../../../src/shared/browser-overlay/browserFontsRuntime.js");
const BROWSER_FONTS_REFRESH_SOURCE: &str = "void globalThis.__rionStudioBrowserFonts?.refresh?.()";
const CANVAS_SCROLL_LOCK_INITIALIZATION_SCRIPT: &str =
    include_str!("../../../src/shared/browser-overlay/canvasScrollLock.js");
const SYSTEM_RUNTIME_INIT_SCRIPT: &str = r#"
(() => {
  if (!Object.prototype.hasOwnProperty.call(globalThis, "__rionStudioDocumentInstanceId")) {
    const documentId = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    Object.defineProperty(globalThis, "__rionStudioDocumentInstanceId", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: documentId
    });
  }
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
#[cfg(any(windows, test))]
const WINDOWS_RUNTIME_TAB_RESERVATION_SCRIPT: &str = r#"
(() => {
  globalThis.__rionPendingRuntimeTabChromeMutations ??= [];
  globalThis.__rionRuntimeTabChromeReady ??= false;
  globalThis.__rionApplyRuntimeTabChromeMutation ??= (revision, mutation) => {
    if (!globalThis.__rionRuntimeTabChromeReady) {
      globalThis.__rionPendingRuntimeTabChromeMutations.push({ mutation, revision });
      return;
    }
    mutation();
    const internals = globalThis.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return;
    void internals.invoke("rion_runtime_tab_action", {
      action: { type: "presentationApplied", revision }
    }).catch(() => undefined);
  };
  globalThis.__rionPendingRuntimeTabOrder ??= [];
  globalThis.__rionPendingRuntimeTabEnsures ??= [];
  globalThis.__rionPendingRuntimeTabs ??= [];
  globalThis.__rionEnsureRuntimeTab ??= (tab) => {
    globalThis.__rionPendingRuntimeTabEnsures.push(tab);
  };
  globalThis.__rionReserveRuntimeTab ??= (tab) => {
    globalThis.__rionPendingRuntimeTabs.push(tab);
  };
  globalThis.__rionRemoveRuntimeTab ??= (tabId) => {
    globalThis.__rionPendingRuntimeTabs = globalThis.__rionPendingRuntimeTabs
      .filter((tab) => tab.id !== tabId);
  };
  globalThis.__rionReorderRuntimeTabs ??= (tabIds) => {
    globalThis.__rionPendingRuntimeTabOrder = [...tabIds];
  };
})();
"#;

#[cfg(any(windows, test))]
fn windows_runtime_tab_initialization_script(
    window_id: &str,
    window_generation: u64,
    lifecycle_epoch: u64,
    windows_mica_enabled: bool,
) -> Result<String, serde_json::Error> {
    let identity = serde_json::to_string(&json!({
        "windowId": window_id,
        "windowGeneration": window_generation,
        "lifecycleEpoch": lifecycle_epoch,
    }))?;
    Ok(format!(
        "{WINDOWS_RUNTIME_TAB_RESERVATION_SCRIPT}\nObject.defineProperty(globalThis, '__rionRuntimeTabWindowsMicaEnabled', {{ configurable: false, enumerable: false, writable: false, value: {windows_mica_enabled} }});\nObject.defineProperty(globalThis, '__rionRuntimeTabChromeIdentity', {{ configurable: false, enumerable: false, writable: false, value: Object.freeze({identity}) }});"
    ))
}

fn native_runtime_window_title_for_platform(platform: &str, saved_name: Option<&str>) -> String {
    if platform == "windows"
        && let Some(saved_name) = saved_name.filter(|name| !name.trim().is_empty())
    {
        format!("{saved_name} — {RION_STUDIO_APP_NAME}")
    } else if platform == "macos"
        && let Some(saved_name) = saved_name.filter(|name| !name.trim().is_empty())
    {
        saved_name.to_owned()
    } else {
        RION_STUDIO_APP_NAME.to_owned()
    }
}

pub(crate) fn native_runtime_window_title(saved_name: Option<&str>) -> String {
    #[cfg(target_os = "macos")]
    const PLATFORM: &str = "macos";
    #[cfg(not(target_os = "macos"))]
    const PLATFORM: &str = "windows";
    native_runtime_window_title_for_platform(PLATFORM, saved_name)
}

fn next_zoom_factor(current: f64, action: &str, minimum: f64, maximum: f64) -> f64 {
    let value = match action {
        "in" => current + 0.05,
        "out" => current - 0.05,
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
    include_str!("../../../src/shared/browser-overlay/macroOverlayNativeBridge.js");

struct RoleSurface {
    current_url: Option<Url>,
    generation: u64,
    high_refresh_rate_status: HighRefreshRateDiagnosticStatus,
    lifecycle: Arc<SurfaceLifecycleTracker>,
    navigation: Arc<NavigationTracker>,
    rect: rion_core::StateNormalizedRectRecord,
    surface_instance_id: String,
    webview: Webview,
    zoom_factor: f64,
}

struct RolePlaceholderSurface {
    surface_instance_id: String,
    webview: Webview,
}

struct RuntimeRoleSlot {
    owner_generation: Option<u64>,
    placeholder: Option<RolePlaceholderSurface>,
    rect: StateNormalizedRectRecord,
    role: StateRoleRecord,
    slot_id: String,
    zoom_factor: f64,
}

#[derive(Clone)]
struct RuntimeProjectionMetadata {
    games: Vec<StateGameRecord>,
    roles: Vec<StateRoleRecord>,
    window_preferences: RuntimeWindowPreferencesRecord,
}

impl RuntimeProjectionMetadata {
    fn from_app_snapshot(snapshot: &CoreAppSnapshotRecord) -> Self {
        Self {
            games: snapshot.state.games.clone(),
            roles: snapshot.state.roles.clone(),
            window_preferences: snapshot
                .state
                .runtime_window_preferences
                .clone()
                .unwrap_or(RuntimeWindowPreferencesRecord {
                    always_hide_tab_close_button: false,
                    always_show_toolbar_in_full_screen: false,
                    restore_game_windows_on_startup: true,
                }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeRolePlaceholderIdentity {
    pub(crate) blocked: bool,
    #[serde(default)]
    pub(crate) unavailable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) owner_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) owner_tab_name: Option<String>,
    pub(crate) role_id: String,
    pub(crate) role_name: String,
    pub(crate) slot_id: String,
    pub(crate) tab_id: String,
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
    store_reusable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum SurfaceIsolationProgress {
    #[default]
    Live,
    Requested,
    Isolated,
    Failed {
        code: &'static str,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SurfaceIsolationRequest {
    Started,
    Joined,
    AlreadyIsolated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SurfaceIsolationClaim {
    Owner,
    Joined,
    AlreadyIsolated,
}

#[derive(Clone, Default)]
struct SurfaceReleaseState {
    #[cfg(windows)]
    browser_process_exited: bool,
    controller_released: bool,
    parent_window_destroyed: bool,
    isolation_progress: SurfaceIsolationProgress,
    isolated: bool,
    native_surface_released: bool,
    terminal_failure: Option<SurfaceLifecycleFailure>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SurfaceLifecycleFailure {
    code: &'static str,
    message: String,
}

struct SurfaceLifecycleTracker {
    #[cfg(windows)]
    browser_process_id: AtomicU64,
    #[cfg(windows)]
    controller_identity: AtomicU64,
    #[cfg(windows)]
    navigation_id: AtomicU64,
    #[cfg(target_os = "macos")]
    native_token: AtomicU64,
    native_isolation_event: AtomicU8,
    stale_native_event_count: AtomicU64,
    changed: watch::Sender<u64>,
    release: Mutex<SurfaceReleaseState>,
}

impl Default for SurfaceLifecycleTracker {
    fn default() -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            #[cfg(windows)]
            browser_process_id: AtomicU64::new(0),
            #[cfg(windows)]
            controller_identity: AtomicU64::new(0),
            #[cfg(windows)]
            navigation_id: AtomicU64::new(0),
            #[cfg(target_os = "macos")]
            native_token: AtomicU64::new(0),
            native_isolation_event: AtomicU8::new(0),
            stale_native_event_count: AtomicU64::new(0),
            changed,
            release: Mutex::new(SurfaceReleaseState::default()),
        }
    }
}

impl SurfaceLifecycleTracker {
    fn publish_event(&self) {
        self.changed.send_modify(|revision| {
            *revision = revision.saturating_add(1);
        });
    }

    fn record_native_isolation_event(&self, event: u8) {
        self.native_isolation_event.store(event, Ordering::Release);
    }

    #[cfg(windows)]
    fn record_windows_navigation_started(&self, navigation_id: u64) {
        if navigation_id == 0 {
            return;
        }
        let requested = self.release.lock().is_ok_and(|release| {
            matches!(release.isolation_progress, SurfaceIsolationProgress::Requested)
        });
        if requested
            && self
                .navigation_id
                .compare_exchange(0, navigation_id, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            self.record_native_isolation_event(1);
            self.publish_event();
        }
    }

    fn native_isolation_event(&self) -> u8 {
        self.native_isolation_event.load(Ordering::Acquire)
    }

    fn record_stale_native_event(&self) {
        self.stale_native_event_count.fetch_add(1, Ordering::AcqRel);
    }

    fn stale_native_event_count(&self) -> u64 {
        self.stale_native_event_count.load(Ordering::Acquire)
    }

    fn claim_isolation(&self) -> RuntimeResult<SurfaceIsolationClaim> {
        let mut release = self.release.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_SURFACE_LIFECYCLE_FAILED",
                "The native surface lifecycle lock was poisoned.",
            )
        })?;
        if let Some(failure) = release.terminal_failure.as_ref() {
            return Err(RuntimeError::new(failure.code, failure.message.clone()));
        }
        if release.isolated || release.native_surface_released {
            release.isolation_progress = SurfaceIsolationProgress::Isolated;
            return Ok(SurfaceIsolationClaim::AlreadyIsolated);
        }
        match &release.isolation_progress {
            SurfaceIsolationProgress::Live => {
                release.isolation_progress = SurfaceIsolationProgress::Requested;
                Ok(SurfaceIsolationClaim::Owner)
            }
            SurfaceIsolationProgress::Requested => Ok(SurfaceIsolationClaim::Joined),
            SurfaceIsolationProgress::Isolated => Ok(SurfaceIsolationClaim::AlreadyIsolated),
            SurfaceIsolationProgress::Failed { code, message } => {
                Err(RuntimeError::new(code, message.clone()))
            }
        }
    }

    fn fail_isolation(&self, error: &RuntimeError) {
        if let Ok(mut release) = self.release.lock() {
            if release.terminal_failure.is_some()
                || release.isolated
                || release.native_surface_released
            {
                return;
            }
            release.isolation_progress = SurfaceIsolationProgress::Failed {
                code: error.code,
                message: error.message.clone(),
            };
            release.terminal_failure = Some(SurfaceLifecycleFailure {
                code: error.code,
                message: error.message.clone(),
            });
            drop(release);
            self.publish_event();
        }
    }

    fn fail_release(&self, error: &RuntimeError) {
        if let Ok(mut release) = self.release.lock() {
            if release.terminal_failure.is_some() || release.native_surface_released {
                return;
            }
            release.terminal_failure = Some(SurfaceLifecycleFailure {
                code: error.code,
                message: error.message.clone(),
            });
            drop(release);
            self.publish_event();
        }
    }

    fn mark_isolated(&self, native_event: u8) -> bool {
        if let Ok(mut release) = self.release.lock() {
            if release.terminal_failure.is_some()
                || release.isolated
                || release.native_surface_released
                || !matches!(
                    release.isolation_progress,
                    SurfaceIsolationProgress::Requested
                )
            {
                return false;
            }
            release.isolated = true;
            release.isolation_progress = SurfaceIsolationProgress::Isolated;
            drop(release);
            self.record_native_isolation_event(native_event);
            self.publish_event();
            return true;
        }
        false
    }

    #[cfg(windows)]
    fn mark_browser_process_exited(&self) -> bool {
        if let Ok(mut release) = self.release.lock() {
            if release.terminal_failure.is_some()
                || release.isolated
                || release.native_surface_released
                || !matches!(
                    release.isolation_progress,
                    SurfaceIsolationProgress::Requested
                )
            {
                return false;
            }
            release.browser_process_exited = true;
            release.isolated = true;
            release.isolation_progress = SurfaceIsolationProgress::Isolated;
            drop(release);
            self.record_native_isolation_event(5);
            self.publish_event();
            return true;
        }
        false
    }

    fn mark_process_terminated(&self) -> bool {
        if let Ok(mut release) = self.release.lock() {
            if release.terminal_failure.is_some()
                || release.isolated
                || release.native_surface_released
                || !matches!(
                    release.isolation_progress,
                    SurfaceIsolationProgress::Requested
                )
            {
                return false;
            }
            release.isolated = true;
            release.isolation_progress = SurfaceIsolationProgress::Isolated;
            drop(release);
            self.record_native_isolation_event(5);
            self.publish_event();
            return true;
        }
        false
    }

    fn close_intent_owns_process_failure(&self) -> bool {
        self.release.lock().is_ok_and(|release| {
            !matches!(
                release.isolation_progress,
                SurfaceIsolationProgress::Live
            )
        })
    }

    fn mark_controller_released(&self) {
        if let Ok(mut release) = self.release.lock() {
            if release.terminal_failure.is_some()
                || !release.native_surface_released
                || release.controller_released
            {
                return;
            }
            release.controller_released = true;
            drop(release);
            self.publish_event();
        }
    }

    fn mark_parent_window_destroyed(&self) -> bool {
        if let Ok(mut release) = self.release.lock() {
            if release.terminal_failure.is_some() || release.parent_window_destroyed {
                return false;
            }
            release.controller_released = true;
            release.parent_window_destroyed = true;
            release.isolated = true;
            release.isolation_progress = SurfaceIsolationProgress::Isolated;
            release.native_surface_released = true;
            drop(release);
            self.record_native_isolation_event(11);
            self.publish_event();
            return true;
        }
        false
    }

    fn parent_window_destroyed(&self) -> bool {
        self.release
            .lock()
            .map(|release| release.parent_window_destroyed)
            .unwrap_or(false)
    }

    fn mark_native_surface_released(&self) {
        if let Ok(mut release) = self.release.lock() {
            if release.terminal_failure.is_some()
                || !release.isolated
                || release.native_surface_released
            {
                return;
            }
            release.isolated = true;
            release.isolation_progress = SurfaceIsolationProgress::Isolated;
            release.native_surface_released = true;
            drop(release);
            self.publish_event();
        }
    }

    fn native_surface_is_released(&self) -> bool {
        self.release
            .lock()
            .map(|release| release.native_surface_released)
            .unwrap_or(false)
    }

    fn cancel_pending(&self, code: &'static str, message: &str) -> bool {
        self.cancel_close_intent(code, message, false)
    }

    fn cancel_accepted_intent(&self, code: &'static str, message: &str) -> bool {
        self.cancel_close_intent(code, message, true)
    }

    fn cancel_close_intent(
        &self,
        code: &'static str,
        message: &str,
        include_live_intent: bool,
    ) -> bool {
        let Ok(mut release) = self.release.lock() else {
            return false;
        };
        let pending = release.terminal_failure.is_none()
            && !release.native_surface_released
            && (include_live_intent
                || release.isolated
                || matches!(
                    release.isolation_progress,
                    SurfaceIsolationProgress::Requested
                ));
        if !pending {
            return false;
        }
        if !release.isolated {
            release.isolation_progress = SurfaceIsolationProgress::Failed {
                code,
                message: message.to_owned(),
            };
        }
        release.terminal_failure = Some(SurfaceLifecycleFailure {
            code,
            message: message.to_owned(),
        });
        drop(release);
        self.publish_event();
        true
    }

    #[cfg(test)]
    fn process_termination_completed_close(&self) -> bool {
        self.release.lock().is_ok_and(|release| {
            matches!(release.isolation_progress, SurfaceIsolationProgress::Isolated)
                && self.native_isolation_event() == 5
        })
    }

    fn store_is_reusable(&self, platform: &str) -> bool {
        self.release
            .lock()
            .is_ok_and(|release| surface_store_reusable(platform, &release))
    }

    async fn wait_for_isolation_event(&self) -> RuntimeResult<()> {
        self.wait_for_event(|release| {
            release.isolated || release.native_surface_released
        })
        .await
    }

    async fn wait_for_native_release_event(&self) -> RuntimeResult<()> {
        self.wait_for_event(|release| release.native_surface_released)
            .await
    }

    async fn wait_for_store_reusable_event(&self, platform: &str) -> RuntimeResult<()> {
        self.wait_for_event(|release| surface_store_reusable(platform, release))
            .await
    }

    async fn wait_for_event(
        &self,
        complete: impl Fn(&SurfaceReleaseState) -> bool,
    ) -> RuntimeResult<()> {
        let mut changed = self.changed.subscribe();
        loop {
            let release = self
                .release
                .lock()
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_SURFACE_LIFECYCLE_FAILED",
                        "The native surface lifecycle lock was poisoned.",
                    )
                })?
                .clone();
            if let Some(failure) = release.terminal_failure.as_ref() {
                return Err(RuntimeError::new(failure.code, failure.message.clone()));
            }
            if complete(&release) {
                return Ok(());
            }
            changed.changed().await.map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_SURFACE_LIFECYCLE_CANCELLED",
                    "The native surface lifecycle event stream stopped.",
                )
            })?;
        }
    }
}

fn quiesce_platform_surface(
    webview: &Webview,
    lifecycle: &Arc<SurfaceLifecycleTracker>,
) -> RuntimeResult<SurfaceIsolationRequest> {
    match lifecycle.claim_isolation()? {
        SurfaceIsolationClaim::Joined => Ok(SurfaceIsolationRequest::Joined),
        SurfaceIsolationClaim::AlreadyIsolated => Ok(SurfaceIsolationRequest::AlreadyIsolated),
        SurfaceIsolationClaim::Owner => match perform_platform_surface_quiesce(webview, lifecycle) {
            Ok(()) => Ok(SurfaceIsolationRequest::Started),
            Err(error) => {
                lifecycle.fail_isolation(&error);
                Err(error)
            }
        },
    }
}

fn surface_store_reusable(platform: &str, release: &SurfaceReleaseState) -> bool {
    match platform {
        "windows" => release.controller_released && release.native_surface_released,
        "macos" => release.controller_released && release.native_surface_released,
        _ => release.controller_released,
    }
}
