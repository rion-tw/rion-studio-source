use std::cell::RefCell;

use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    UI::{
        HiDpi::GetDpiForWindow,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            BeginDeferWindowPos, DeferWindowPos, EndDeferWindowPos, GetClientRect,
            SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOOWNERZORDER, SWP_NOZORDER,
            WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCDESTROY, WM_SIZE,
        },
    },
};

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
}

#[derive(Clone, Copy, Debug, Default)]
struct WindowsLiveResizeCounters {
    applied: u64,
    deferred: u64,
    errors: u64,
    fallback: u64,
    received: u64,
}

impl WindowsLiveResizeCounters {
    fn saturating_add(self, other: Self) -> Self {
        Self {
            applied: self.applied.saturating_add(other.applied),
            deferred: self.deferred.saturating_add(other.deferred),
            errors: self.errors.saturating_add(other.errors),
            fallback: self.fallback.saturating_add(other.fallback),
            received: self.received.saturating_add(other.received),
        }
    }
}

#[derive(Debug)]
struct WindowsLiveResizeHost {
    counters: WindowsLiveResizeCounters,
    frame_sequence: u64,
    generation: u64,
    last_batch_failed: bool,
    last_native_attempt_at: Option<Instant>,
    last_applied_frame: Option<WindowsLiveResizeFrame>,
    plan: Option<WindowsLiveResizePlan>,
    plan_epoch: u64,
    subclass_id: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowsLiveResizeFrame {
    height: u32,
    plan_epoch: u64,
    sequence: u64,
    width: u32,
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

fn windows_live_resize_install_host(window: &Window, generation: u64) -> RuntimeResult<()> {
    let install_window = window.clone();
    window
        .run_on_main_thread(move || {
            let Ok(hwnd) = install_window.hwnd() else {
                return;
            };
            let key = windows_hwnd_key(hwnd);
            let subclass_id = generation.max(1) as usize;
            WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
                let mut registry = registry.borrow_mut();
                if let Some(previous) = registry.hosts.remove(&key) {
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
                    registry.hosts.insert(
                        key,
                        WindowsLiveResizeHost {
                            counters: WindowsLiveResizeCounters::default(),
                            frame_sequence: 0,
                            generation,
                            last_batch_failed: false,
                            last_native_attempt_at: None,
                            last_applied_frame: None,
                            plan: None,
                            plan_epoch: 0,
                            subclass_id,
                        },
                    );
                }
            });
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
                WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
                    let mut registry = registry.borrow_mut();
                    registry.surfaces.insert(
                        label.clone(),
                        WindowsLiveResizeSurface { controller, hwnd },
                    );
                    windows_live_resize_invalidate_surface_plans(&mut registry, &label);
                });
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
    WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.surfaces.insert(
            label.clone(),
            WindowsLiveResizeSurface { controller, hwnd },
        );
        windows_live_resize_invalidate_surface_plans(&mut registry, &label);
    });
}

fn windows_live_resize_unregister_surface(webview: &Webview) {
    let label = webview.label().to_owned();
    let app = webview.app_handle().clone();
    let _ = app.run_on_main_thread(move || {
        WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            registry.surfaces.remove(&label);
            windows_live_resize_invalidate_surface_plans(&mut registry, &label);
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
        WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            let Some(host) = registry.hosts.get_mut(&key) else {
                return;
            };
            if !windows_live_resize_plan_is_current(
                host.generation,
                host.plan.as_ref().map(|current| current.revision),
                plan.generation,
                plan.revision,
            ) {
                return;
            }
            let topology_changed = host
                .plan
                .as_ref()
                .is_none_or(|current| !windows_live_resize_plans_match(current, &plan));
            host.plan = Some(plan);
            if topology_changed {
                windows_live_resize_advance_epoch(host);
            }
        });
    });
}

fn windows_live_resize_advance_epoch(host: &mut WindowsLiveResizeHost) {
    host.plan_epoch = host.plan_epoch.saturating_add(1).max(1);
    host.last_batch_failed = false;
    host.last_applied_frame = None;
}

fn windows_live_resize_invalidate_surface_plans(
    registry: &mut WindowsLiveResizeRegistry,
    label: &str,
) {
    for host in registry.hosts.values_mut() {
        if host
            .plan
            .as_ref()
            .is_some_and(|plan| windows_live_resize_plan_contains_label(plan, label))
        {
            windows_live_resize_advance_epoch(host);
        }
    }
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
        WindowsLiveResizeObservation {
            client_height,
            client_width,
            counters,
            event_height,
            event_width,
            frame_sequence: host.last_applied_frame.map_or(0, |frame| frame.sequence),
            matched_latest_frame,
            native_fast_path_available,
            match_status,
            plan_epoch: host.plan_epoch,
        }
    })
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
    let Some(frame) = host.last_applied_frame else {
        return (false, "frame-unavailable");
    };
    if frame.plan_epoch != host.plan_epoch {
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

fn windows_live_resize_should_submit(
    last_attempt_at: Option<Instant>,
    now: Instant,
    force: bool,
) -> bool {
    force
        || last_attempt_at.is_none_or(|last| {
            now.saturating_duration_since(last) >= WINDOW_RESIZE_FRAME_INTERVAL
        })
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
        WM_ENTERSIZEMOVE => {}
        WM_SIZE => {
            let width = lparam.0 as u32 & 0xffff;
            let height = (lparam.0 as u32 >> 16) & 0xffff;
            if width > 0 && height > 0 {
                windows_live_resize_apply(hwnd, width, height, false);
            }
        }
        WM_EXITSIZEMOVE => {
            if let Some((width, height)) = windows_live_resize_client_size(hwnd) {
                windows_live_resize_apply(hwnd, width, height, true);
            }
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

fn windows_live_resize_apply(
    hwnd: HWND,
    physical_width: u32,
    physical_height: u32,
    force: bool,
) {
    WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let key = windows_hwnd_key(hwnd);
        if let Some(host) = registry.hosts.get_mut(&key) {
            host.counters.received = host.counters.received.saturating_add(1);
        }
        let Some(plan) = registry.hosts.get(&key).and_then(|host| host.plan.clone()) else {
            if let Some(host) = registry.hosts.get_mut(&key) {
                host.counters.fallback = host.counters.fallback.saturating_add(1);
            }
            return;
        };
        let Some(surfaces) = windows_live_resize_collect_surfaces(&registry, &plan) else {
            if let Some(host) = registry.hosts.get_mut(&key) {
                host.counters.fallback = host.counters.fallback.saturating_add(1);
            }
            return;
        };
        let now = Instant::now();
        let should_submit = registry.hosts.get(&key).is_some_and(|host| {
            windows_live_resize_should_submit(host.last_native_attempt_at, now, force)
        });
        if !should_submit {
            if let Some(host) = registry.hosts.get_mut(&key) {
                host.counters.deferred = host.counters.deferred.saturating_add(1);
            }
            return;
        }
        if let Some(host) = registry.hosts.get_mut(&key) {
            host.last_native_attempt_at = Some(now);
        }
        let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
        let scale = f64::from(dpi) / 96.0;
        let bounds = windows_live_resize_resolve_bounds(
            &plan,
            physical_width,
            physical_height,
            scale,
        );
        match bounds.and_then(|bounds| windows_live_resize_submit_batch(&surfaces, &bounds)) {
            Ok(()) => {
                if let Some(host) = registry.hosts.get_mut(&key) {
                    host.counters.applied = host.counters.applied.saturating_add(1);
                    host.frame_sequence = host.frame_sequence.saturating_add(1);
                    host.last_batch_failed = false;
                    host.last_applied_frame = Some(WindowsLiveResizeFrame {
                        height: physical_height,
                        plan_epoch: host.plan_epoch,
                        sequence: host.frame_sequence,
                        width: physical_width,
                    });
                }
            }
            Err(()) => {
                if let Some(host) = registry.hosts.get_mut(&key) {
                    host.counters.errors = host.counters.errors.saturating_add(1);
                    host.last_batch_failed = true;
                    host.last_applied_frame = None;
                }
            }
        }
    });
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
