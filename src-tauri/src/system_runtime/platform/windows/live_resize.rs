use std::cell::RefCell;

use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    UI::{
        HiDpi::GetDpiForWindow,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            BeginDeferWindowPos, DeferWindowPos, EndDeferWindowPos, GetClientRect,
            IsZoomed, PostMessageW, SIZE_MAXIMIZED, SIZE_MINIMIZED, SWP_NOACTIVATE,
            SWP_NOCOPYBITS, SWP_NOOWNERZORDER, SWP_NOZORDER, WM_APP, WM_DPICHANGED,
            WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVE, WM_MOVING, WM_NCDESTROY, WM_SIZE,
        },
    },
};

const WM_RION_GEOMETRY_FLUSH: u32 = WM_APP + 0x52;

#[derive(Clone, Debug)]
struct WindowsLiveResizeRolePlan {
    input: LayoutRoleInput,
    label: String,
}

#[derive(Clone, Debug)]
struct WindowsLiveResizeDividerPlan {
    axis: String,
    index: u32,
    label: String,
}

#[derive(Clone, Debug)]
struct WindowsLiveResizePlan {
    dividers: Vec<WindowsLiveResizeDividerPlan>,
    gap: u32,
    generation: u64,
    revision: u64,
    roles: Vec<WindowsLiveResizeRolePlan>,
    tab_strip_height: f64,
    tab_strip_label: String,
}

#[derive(Clone)]
struct WindowsLiveResizeSurface {
    controller: ICoreWebView2Controller,
    hwnd: HWND,
    label: String,
}

#[derive(Clone, Copy, Debug, Default)]
struct WindowsLiveResizeCounters {
    applied: u64,
    deferred: u64,
    errors: u64,
    fallback: u64,
    parent_position_applied: u64,
    parent_position_errors: u64,
    parent_position_received: u64,
    received: u64,
    unchanged: u64,
}

impl WindowsLiveResizeCounters {
    fn record_native_resize_applied(&mut self) {
        self.applied = self.applied.saturating_add(1);
    }

    fn record_parent_position(&mut self, applied: u64, errors: u64) {
        self.parent_position_received = self.parent_position_received.saturating_add(1);
        self.parent_position_applied = self.parent_position_applied.saturating_add(applied);
        self.parent_position_errors = self.parent_position_errors.saturating_add(errors);
    }

}

struct WindowsLiveResizeHost {
    counters: WindowsLiveResizeCounters,
    flush_posted: bool,
    frame_sequence: u64,
    generation: u64,
    interactive_resize: bool,
    last_batch_failed: bool,
    last_materialized_key: Option<WindowsGeometryKey>,
    last_surface_bounds: HashMap<String, WindowsLiveResizeBounds>,
    pending_frame: Option<WindowsGeometryPendingFrame>,
    plan: Option<WindowsLiveResizePlan>,
    plan_epoch: u64,
    receipt_handler: WindowsGeometryReceiptHandler,
    subclass_id: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowsGeometryKey {
    dpi: u32,
    frame_revision: u64,
    generation: u64,
    height: u32,
    plan_revision: u64,
    presentation: WindowsGeometryPresentation,
    width: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsGeometryPresentation {
    Maximized,
    Restored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsGeometryStatus {
    Applied,
    Failed,
    Unchanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowsGeometryReceipt {
    key: WindowsGeometryKey,
    status: WindowsGeometryStatus,
    terminal: bool,
}

type WindowsGeometryReceiptHandler = Arc<dyn Fn(WindowsGeometryReceipt) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowsGeometryPendingFrame {
    dpi: u32,
    frame_revision: u64,
    height: u32,
    presentation: WindowsGeometryPresentation,
    terminal: bool,
    width: u32,
}

#[derive(Clone)]
struct WindowsGeometrySubmission {
    bounds: Vec<WindowsLiveResizeBounds>,
    key: WindowsGeometryKey,
    last_batch_failed: bool,
    last_surface_bounds: HashMap<String, WindowsLiveResizeBounds>,
    plan_epoch: u64,
    surfaces: Vec<WindowsLiveResizeSurface>,
    terminal: bool,
}

#[derive(Default)]
struct WindowsLiveResizeRegistry {
    hosts: HashMap<usize, WindowsLiveResizeHost>,
    surfaces: HashMap<String, WindowsLiveResizeSurface>,
}

#[derive(Clone, Copy, Debug, Default)]
struct WindowsLiveResizeObservation {
    client_height: u32,
    client_width: u32,
    counters: WindowsLiveResizeCounters,
    event_height: u32,
    event_width: u32,
    frame_sequence: u64,
    native_fast_path_available: bool,
    native_frame_unchanged: bool,
    matched_latest_frame: bool,
    match_status: &'static str,
    plan_epoch: u64,
}

thread_local! {
    static WINDOWS_LIVE_RESIZE_REGISTRY: RefCell<WindowsLiveResizeRegistry> =
        RefCell::new(WindowsLiveResizeRegistry::default());
}

fn windows_hwnd_key(hwnd: HWND) -> usize {
    hwnd.0 as usize
}

fn windows_hwnd_from_key(key: usize) -> HWND {
    HWND(key as *mut _)
}

fn windows_live_resize_install_host(
    window: &Window,
    generation: u64,
    receipt_handler: WindowsGeometryReceiptHandler,
) -> RuntimeResult<()> {
    let install_window = window.clone();
    window
        .run_on_main_thread(move || {
            let Ok(hwnd) = install_window.hwnd() else {
                return;
            };
            let key = windows_hwnd_key(hwnd);
            let subclass_id = generation.max(1) as usize;
            let previous = WINDOWS_LIVE_RESIZE_REGISTRY
                .with(|registry| registry.borrow_mut().hosts.remove(&key));
            if let Some(previous) = previous {
                unsafe {
                    let _ = RemoveWindowSubclass(
                        hwnd,
                        Some(windows_live_resize_subclass_proc),
                        previous.subclass_id,
                    );
                }
            }
            let installed = unsafe {
                SetWindowSubclass(
                    hwnd,
                    Some(windows_live_resize_subclass_proc),
                    subclass_id,
                    generation as usize,
                )
                .as_bool()
            };
            if installed {
                WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
                    registry.borrow_mut().hosts.insert(
                        key,
                        WindowsLiveResizeHost {
                            counters: WindowsLiveResizeCounters::default(),
                            flush_posted: false,
                            frame_sequence: 0,
                            generation,
                            interactive_resize: false,
                            last_batch_failed: false,
                            last_materialized_key: None,
                            last_surface_bounds: HashMap::new(),
                            pending_frame: None,
                            plan: None,
                            plan_epoch: 0,
                            receipt_handler,
                            subclass_id,
                        },
                    );
                });
            }
        })
        .map_err(RuntimeError::tauri)
}

fn windows_live_resize_register_webview(webview: &Webview) -> RuntimeResult<()> {
    let label = webview.label().to_owned();
    webview
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let mut hwnd = HWND::default();
            if controller.ParentWindow(&mut hwnd).is_ok() && !hwnd.is_invalid() {
                let invalidated = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
                    let mut registry = registry.borrow_mut();
                    registry.surfaces.insert(
                        label.clone(),
                        WindowsLiveResizeSurface {
                            controller,
                            hwnd,
                            label: label.clone(),
                        },
                    );
                    windows_live_resize_invalidate_surface_plans(&mut registry, &label)
                });
                for key in invalidated {
                    let host = windows_hwnd_from_key(key);
                    windows_live_resize_queue_current_frame(host, false);
                    windows_live_resize_flush(host);
                }
            }
        })
        .map_err(RuntimeError::tauri)
}

fn windows_live_resize_register_controller(
    label: String,
    controller: ICoreWebView2Controller,
) {
    let mut hwnd = HWND::default();
    if unsafe { controller.ParentWindow(&mut hwnd) }.is_err() || hwnd.is_invalid() {
        return;
    }
    let invalidated = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.surfaces.insert(
            label.clone(),
            WindowsLiveResizeSurface {
                controller,
                hwnd,
                label: label.clone(),
            },
        );
        windows_live_resize_invalidate_surface_plans(&mut registry, &label)
    });
    for key in invalidated {
        let host = windows_hwnd_from_key(key);
        windows_live_resize_queue_current_frame(host, false);
        windows_live_resize_flush(host);
    }
}

fn windows_live_resize_unregister_surface(webview: &Webview) {
    let label = webview.label().to_owned();
    let app = webview.app_handle().clone();
    let _ = app.run_on_main_thread(move || {
        WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            registry.surfaces.remove(&label);
            let _ = windows_live_resize_invalidate_surface_plans(&mut registry, &label);
        });
    });
}

fn windows_live_resize_publish_plan(window: &Window, plan: WindowsLiveResizePlan) {
    let publish_window = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(hwnd) = publish_window.hwnd() else {
            return;
        };
        let key = windows_hwnd_key(hwnd);
        let accepted = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            let Some(host) = registry.hosts.get_mut(&key) else {
                return false;
            };
            if !windows_live_resize_plan_is_current(
                host.generation,
                host.plan.as_ref().map(|current| current.revision),
                plan.generation,
                plan.revision,
            ) {
                return false;
            }
            let topology_changed = host
                .plan
                .as_ref()
                .is_none_or(|current| !windows_live_resize_plans_match(current, &plan));
            host.plan = Some(plan);
            if topology_changed {
                windows_live_resize_advance_epoch(host);
            }
            true
        });
        if accepted {
            windows_live_resize_queue_current_frame(hwnd, false);
            windows_live_resize_flush(hwnd);
        }
    });
}

fn windows_live_resize_advance_epoch(host: &mut WindowsLiveResizeHost) {
    host.plan_epoch = host.plan_epoch.saturating_add(1).max(1);
    host.last_batch_failed = false;
    host.last_materialized_key = None;
}

fn windows_live_resize_invalidate_surface_plans(
    registry: &mut WindowsLiveResizeRegistry,
    label: &str,
) -> Vec<usize> {
    let mut invalidated = Vec::new();
    for (key, host) in &mut registry.hosts {
        if host
            .plan
            .as_ref()
            .is_some_and(|plan| windows_live_resize_plan_contains_label(plan, label))
        {
            host.last_surface_bounds.remove(label);
            windows_live_resize_advance_epoch(host);
            invalidated.push(*key);
        }
    }
    invalidated
}

fn windows_live_resize_plan_contains_label(plan: &WindowsLiveResizePlan, label: &str) -> bool {
    plan.tab_strip_label == label
        || plan.roles.iter().any(|role| role.label == label)
        || plan.dividers.iter().any(|divider| divider.label == label)
}

fn windows_live_resize_plans_match(
    current: &WindowsLiveResizePlan,
    next: &WindowsLiveResizePlan,
) -> bool {
    current.generation == next.generation
        && current.gap == next.gap
        && current.tab_strip_height.to_bits() == next.tab_strip_height.to_bits()
        && current.tab_strip_label == next.tab_strip_label
        && current.roles.len() == next.roles.len()
        && current.roles.iter().zip(&next.roles).all(|(left, right)| {
            left.label == right.label
                && left.input.role_id == right.input.role_id
                && left.input.rect.x.to_bits() == right.input.rect.x.to_bits()
                && left.input.rect.y.to_bits() == right.input.rect.y.to_bits()
                && left.input.rect.width.to_bits() == right.input.rect.width.to_bits()
                && left.input.rect.height.to_bits() == right.input.rect.height.to_bits()
        })
        && current.dividers.len() == next.dividers.len()
        && current
            .dividers
            .iter()
            .zip(&next.dividers)
            .all(|(left, right)| {
                left.axis == right.axis
                    && left.index == right.index
                    && left.label == right.label
            })
}

fn windows_live_resize_plan_is_current(
    host_generation: u64,
    current_revision: Option<u64>,
    plan_generation: u64,
    plan_revision: u64,
) -> bool {
    host_generation == plan_generation
        && current_revision.is_none_or(|current| plan_revision >= current)
}

fn windows_live_resize_observe(
    window: &Window,
    event_width: u32,
    event_height: u32,
) -> WindowsLiveResizeObservation {
    let Ok(hwnd) = window.hwnd() else {
        return WindowsLiveResizeObservation {
            event_height,
            event_width,
            match_status: "host-unavailable",
            ..WindowsLiveResizeObservation::default()
        };
    };
    let client_size = windows_live_resize_client_size(hwnd);
    WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let key = windows_hwnd_key(hwnd);
        let native_fast_path_available = registry
            .hosts
            .get(&key)
            .filter(|host| !host.last_batch_failed)
            .and_then(|host| host.plan.as_ref())
            .is_some_and(|plan| windows_live_resize_plan_surfaces_available(&registry, plan));
        let Some(host) = registry.hosts.get_mut(&key) else {
            return WindowsLiveResizeObservation {
                client_height: client_size.map_or(0, |size| size.1),
                client_width: client_size.map_or(0, |size| size.0),
                event_height,
                event_width,
                match_status: "host-unavailable",
                ..WindowsLiveResizeObservation::default()
            };
        };
        let counters = std::mem::take(&mut host.counters);
        let (client_width, client_height) = client_size.unwrap_or((event_width, event_height));
        let (matched_latest_frame, match_status) =
            windows_live_resize_frame_match(host, client_size);
        let native_frame_unchanged = windows_live_resize_counters_are_unchanged(
            counters,
            matched_latest_frame,
        );
        WindowsLiveResizeObservation {
            client_height,
            client_width,
            counters,
            event_height,
            event_width,
            frame_sequence: host
                .last_materialized_key
                .map_or(0, |frame| frame.frame_revision),
            matched_latest_frame,
            native_fast_path_available,
            native_frame_unchanged,
            match_status,
            plan_epoch: host.plan_epoch,
        }
    })
}

fn windows_live_resize_counters_are_unchanged(
    counters: WindowsLiveResizeCounters,
    matched_latest_frame: bool,
) -> bool {
    matched_latest_frame
        && counters.received > 0
        && counters.unchanged == counters.received
        && counters.applied == 0
        && counters.deferred == 0
        && counters.errors == 0
        && counters.fallback == 0
}

fn windows_live_resize_frame_match(
    host: &WindowsLiveResizeHost,
    client_size: Option<(u32, u32)>,
) -> (bool, &'static str) {
    let Some(client_size) = client_size else {
        return (false, "client-rect-unavailable");
    };
    if host.plan.is_none() {
        return (false, "plan-unavailable");
    }
    let Some(frame) = host.last_materialized_key else {
        return (false, "frame-unavailable");
    };
    if host
        .plan
        .as_ref()
        .is_none_or(|plan| frame.plan_revision != plan.revision)
    {
        return (false, "plan-fence");
    }
    if (frame.width, frame.height) != client_size {
        return (false, "size-mismatch");
    }
    (true, "matched")
}

fn windows_live_resize_client_size(hwnd: HWND) -> Option<(u32, u32)> {
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) }
        .ok()
        .and_then(|()| {
            let width = client.right - client.left;
            let height = client.bottom - client.top;
            (width > 0 && height > 0).then_some((width as u32, height as u32))
        })
}

fn windows_live_resize_message_is_actionable(
    size_kind: usize,
    width: u32,
    height: u32,
) -> bool {
    size_kind != SIZE_MINIMIZED as usize && width > 0 && height > 0
}

fn windows_geometry_presentation(size_kind: usize) -> WindowsGeometryPresentation {
    if size_kind == SIZE_MAXIMIZED as usize {
        WindowsGeometryPresentation::Maximized
    } else {
        WindowsGeometryPresentation::Restored
    }
}

fn windows_live_resize_set_interactive(hwnd: HWND, interactive: bool) {
    WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        if let Some(host) = registry.borrow_mut().hosts.get_mut(&windows_hwnd_key(hwnd)) {
            host.interactive_resize = interactive;
        }
    });
}

fn windows_live_resize_is_interactive(hwnd: HWND) -> bool {
    WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        registry
            .borrow()
            .hosts
            .get(&windows_hwnd_key(hwnd))
            .is_some_and(|host| host.interactive_resize)
    })
}

fn windows_live_resize_note_minimized(hwnd: HWND) {
    WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        if let Some(host) = registry.borrow_mut().hosts.get_mut(&windows_hwnd_key(hwnd)) {
            host.counters.received = host.counters.received.saturating_add(1);
        }
    });
}

fn windows_live_resize_queue_current_frame(hwnd: HWND, terminal: bool) {
    let Some((width, height)) = windows_live_resize_client_size(hwnd) else {
        return;
    };
    let presentation = if unsafe { IsZoomed(hwnd) }.as_bool() {
        WindowsGeometryPresentation::Maximized
    } else {
        WindowsGeometryPresentation::Restored
    };
    windows_live_resize_queue_frame(hwnd, width, height, presentation, terminal);
}

fn windows_live_resize_queue_frame(
    hwnd: HWND,
    width: u32,
    height: u32,
    presentation: WindowsGeometryPresentation,
    terminal: bool,
) {
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    let should_post = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let Some(host) = registry.hosts.get_mut(&windows_hwnd_key(hwnd)) else {
            return false;
        };
        host.counters.received = host.counters.received.saturating_add(1);
        host.frame_sequence = host.frame_sequence.saturating_add(1).max(1);
        let next = WindowsGeometryPendingFrame {
            dpi,
            frame_revision: host.frame_sequence,
            height,
            presentation,
            terminal,
            width,
        };
        let (pending, coalesced) = windows_geometry_merge_pending(host.pending_frame, next);
        if coalesced {
            host.counters.deferred = host.counters.deferred.saturating_add(1);
        }
        host.pending_frame = Some(pending);
        if host.flush_posted {
            false
        } else {
            host.flush_posted = true;
            true
        }
    });
    if should_post
        && unsafe {
            PostMessageW(
                Some(hwnd),
                WM_RION_GEOMETRY_FLUSH,
                WPARAM::default(),
                LPARAM::default(),
            )
        }
        .is_err()
    {
        WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
            if let Some(host) = registry.borrow_mut().hosts.get_mut(&windows_hwnd_key(hwnd)) {
                host.flush_posted = false;
                host.counters.errors = host.counters.errors.saturating_add(1);
            }
        });
        windows_live_resize_flush(hwnd);
    }
}

fn windows_geometry_merge_pending(
    previous: Option<WindowsGeometryPendingFrame>,
    mut next: WindowsGeometryPendingFrame,
) -> (WindowsGeometryPendingFrame, bool) {
    if let Some(previous) = previous {
        next.terminal |= previous.terminal;
        (next, true)
    } else {
        (next, false)
    }
}

unsafe extern "system" fn windows_live_resize_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    _generation: usize,
) -> LRESULT {
    let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    match message {
        WM_ENTERSIZEMOVE => windows_live_resize_set_interactive(hwnd, true),
        WM_SIZE => {
            let width = lparam.0 as u32 & 0xffff;
            let height = (lparam.0 as u32 >> 16) & 0xffff;
            if windows_live_resize_message_is_actionable(wparam.0, width, height) {
                windows_live_resize_queue_frame(
                    hwnd,
                    width,
                    height,
                    windows_geometry_presentation(wparam.0),
                    !windows_live_resize_is_interactive(hwnd),
                );
            } else if wparam.0 == SIZE_MINIMIZED as usize {
                windows_live_resize_note_minimized(hwnd);
            }
        }
        WM_EXITSIZEMOVE => {
            windows_live_resize_set_interactive(hwnd, false);
            windows_live_resize_queue_current_frame(hwnd, true);
            windows_live_resize_flush(hwnd);
        }
        WM_DPICHANGED => {
            windows_live_resize_queue_current_frame(
                hwnd,
                !windows_live_resize_is_interactive(hwnd),
            );
        }
        WM_RION_GEOMETRY_FLUSH => windows_live_resize_flush(hwnd),
        message if message == WM_MOVE || message == WM_MOVING => {
            windows_live_resize_notify_parent_position_changed(hwnd);
        }
        WM_NCDESTROY => {
            WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
                let mut registry = registry.borrow_mut();
                if let Some(host) = registry.hosts.remove(&windows_hwnd_key(hwnd))
                    && let Some(plan) = host.plan
                {
                    registry.surfaces.remove(&plan.tab_strip_label);
                    for role in plan.roles {
                        registry.surfaces.remove(&role.label);
                    }
                    for divider in plan.dividers {
                        registry.surfaces.remove(&divider.label);
                    }
                }
            });
            unsafe {
                let _ = RemoveWindowSubclass(
                    hwnd,
                    Some(windows_live_resize_subclass_proc),
                    subclass_id,
                );
            }
        }
        _ => {}
    }
    result
}

fn windows_live_resize_notify_parent_position_changed(hwnd: HWND) {
    let key = windows_hwnd_key(hwnd);
    let surfaces = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let registry = registry.borrow();
        let plan = registry.hosts.get(&key)?.plan.as_ref()?;
        windows_live_resize_collect_surfaces(&registry, plan)
    });
    let Some(surfaces) = surfaces else {
        return;
    };
    let (applied, errors) = windows_live_resize_notify_each(&surfaces, |surface| unsafe {
        surface
            .controller
            .NotifyParentWindowPositionChanged()
            .map_err(|_| ())
    });
    WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let Some(host) = registry.hosts.get_mut(&key) else {
            return;
        };
        host.counters.record_parent_position(applied, errors);
    });
}

fn windows_live_resize_notify_each<T>(
    surfaces: &[T],
    mut notify: impl FnMut(&T) -> Result<(), ()>,
) -> (u64, u64) {
    let mut applied = 0_u64;
    let mut errors = 0_u64;
    for surface in surfaces {
        if notify(surface).is_ok() {
            applied = applied.saturating_add(1);
        } else {
            errors = errors.saturating_add(1);
        }
    }
    (applied, errors)
}

fn windows_live_resize_all_surface_bounds_match(
    surfaces: &[WindowsLiveResizeSurface],
    bounds: &[WindowsLiveResizeBounds],
    last_surface_bounds: &HashMap<String, WindowsLiveResizeBounds>,
    last_batch_failed: bool,
) -> bool {
    let labels = surfaces
        .iter()
        .map(|surface| surface.label.clone())
        .collect::<Vec<_>>();
    windows_geometry_cached_bounds_match(
        &labels,
        bounds,
        last_surface_bounds,
        last_batch_failed,
    )
}

fn windows_geometry_cached_bounds_match(
    labels: &[String],
    bounds: &[WindowsLiveResizeBounds],
    last_surface_bounds: &HashMap<String, WindowsLiveResizeBounds>,
    last_batch_failed: bool,
) -> bool {
    !last_batch_failed
        && !labels.is_empty()
        && labels.len() == bounds.len()
        && labels
            .iter()
            .zip(bounds)
            .all(|(label, bounds)| last_surface_bounds.get(label) == Some(bounds))
}

fn windows_geometry_submission_is_current(
    host_generation: u64,
    host_plan_epoch: u64,
    host_plan_revision: Option<u64>,
    submission: &WindowsGeometrySubmission,
) -> bool {
    host_generation == submission.key.generation
        && host_plan_epoch == submission.plan_epoch
        && host_plan_revision == Some(submission.key.plan_revision)
}

fn windows_live_resize_prepare_submission(hwnd: HWND) -> Option<WindowsGeometrySubmission> {
    let prepared = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let key = windows_hwnd_key(hwnd);
        let host = registry.hosts.get_mut(&key)?;
        host.flush_posted = false;
        let frame = host.pending_frame.take()?;
        let Some(plan) = host.plan.clone() else {
            host.pending_frame = Some(frame);
            host.counters.fallback = host.counters.fallback.saturating_add(1);
            return None;
        };
        let generation = host.generation;
        let last_batch_failed = host.last_batch_failed;
        let last_surface_bounds = host.last_surface_bounds.clone();
        let plan_epoch = host.plan_epoch;
        let Some(surfaces) = windows_live_resize_collect_surfaces(&registry, &plan) else {
            if let Some(host) = registry.hosts.get_mut(&key) {
                host.pending_frame = Some(frame);
                host.counters.fallback = host.counters.fallback.saturating_add(1);
            }
            return None;
        };
        Some((frame, generation, last_batch_failed, last_surface_bounds, plan, plan_epoch, surfaces))
    })?;
    let (frame, generation, last_batch_failed, last_surface_bounds, plan, plan_epoch, surfaces) =
        prepared;
    let key = WindowsGeometryKey {
        dpi: frame.dpi,
        frame_revision: frame.frame_revision,
        generation,
        height: frame.height,
        plan_revision: plan.revision,
        presentation: frame.presentation,
        width: frame.width,
    };
    let bounds = windows_live_resize_resolve_bounds(
        &plan,
        frame.width,
        frame.height,
        f64::from(frame.dpi) / 96.0,
    );
    let Ok(bounds) = bounds else {
        let failed = WindowsGeometrySubmission {
            bounds: Vec::new(),
            key,
            last_batch_failed,
            last_surface_bounds,
            plan_epoch,
            surfaces,
            terminal: frame.terminal,
        };
        windows_live_resize_complete_submission(
            hwnd,
            &failed,
            WindowsGeometryStatus::Failed,
        );
        return None;
    };
    Some(WindowsGeometrySubmission {
        bounds,
        key,
        last_batch_failed,
        last_surface_bounds,
        plan_epoch,
        surfaces,
        terminal: frame.terminal,
    })
}

fn windows_live_resize_complete_submission(
    hwnd: HWND,
    submission: &WindowsGeometrySubmission,
    status: WindowsGeometryStatus,
) {
    let completion = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let host = registry.hosts.get_mut(&windows_hwnd_key(hwnd))?;
        let plan_is_current = windows_geometry_submission_is_current(
            host.generation,
            host.plan_epoch,
            host.plan.as_ref().map(|plan| plan.revision),
            submission,
        );
        if !plan_is_current {
            return None;
        }
        match status {
            WindowsGeometryStatus::Applied => {
                host.counters.record_native_resize_applied();
                host.last_batch_failed = false;
                for (surface, bounds) in submission.surfaces.iter().zip(&submission.bounds) {
                    host.last_surface_bounds
                        .insert(surface.label.clone(), *bounds);
                }
                host.last_materialized_key = Some(submission.key);
            }
            WindowsGeometryStatus::Unchanged => {
                host.counters.unchanged = host.counters.unchanged.saturating_add(1);
                host.last_batch_failed = false;
                host.last_materialized_key = Some(submission.key);
            }
            WindowsGeometryStatus::Failed => {
                host.counters.errors = host.counters.errors.saturating_add(1);
                host.last_batch_failed = true;
            }
        }
        Some((
            Arc::clone(&host.receipt_handler),
            WindowsGeometryReceipt {
                key: submission.key,
                status,
                terminal: submission.terminal,
            },
        ))
    });
    if let Some((handler, receipt)) = completion {
        handler(receipt);
    }
}

fn windows_live_resize_flush(hwnd: HWND) {
    let Some(submission) = windows_live_resize_prepare_submission(hwnd) else {
        return;
    };
    if windows_live_resize_all_surface_bounds_match(
        &submission.surfaces,
        &submission.bounds,
        &submission.last_surface_bounds,
        submission.last_batch_failed,
    ) {
        windows_live_resize_complete_submission(
            hwnd,
            &submission,
            WindowsGeometryStatus::Unchanged,
        );
        return;
    }
    let status = if windows_live_resize_submit_batch(&submission.surfaces, &submission.bounds)
        .is_ok()
    {
        WindowsGeometryStatus::Applied
    } else {
        WindowsGeometryStatus::Failed
    };
    windows_live_resize_complete_submission(hwnd, &submission, status);
}

fn windows_live_resize_collect_surfaces(
    registry: &WindowsLiveResizeRegistry,
    plan: &WindowsLiveResizePlan,
) -> Option<Vec<WindowsLiveResizeSurface>> {
    let labels = std::iter::once(plan.tab_strip_label.as_str())
        .chain(plan.roles.iter().map(|role| role.label.as_str()))
        .chain(plan.dividers.iter().map(|divider| divider.label.as_str()));
    labels
        .map(|label| registry.surfaces.get(label).cloned())
        .collect()
}

fn windows_live_resize_plan_surfaces_available(
    registry: &WindowsLiveResizeRegistry,
    plan: &WindowsLiveResizePlan,
) -> bool {
    let labels = std::iter::once(plan.tab_strip_label.as_str())
        .chain(plan.roles.iter().map(|role| role.label.as_str()))
        .chain(plan.dividers.iter().map(|divider| divider.label.as_str()));
    labels.into_iter().all(|label| registry.surfaces.contains_key(label))
}

include!("live_resize_geometry.rs");
