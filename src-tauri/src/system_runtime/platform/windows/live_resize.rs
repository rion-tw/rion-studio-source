use std::cell::RefCell;

use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    UI::{
        HiDpi::GetDpiForWindow,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            BeginDeferWindowPos, DeferWindowPos, EndDeferWindowPos, GetClientRect,
            SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER, WM_ENTERSIZEMOVE,
            WM_EXITSIZEMOVE, WM_NCDESTROY, WM_SIZE,
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
    errors: u64,
    fallback: u64,
    received: u64,
}

impl WindowsLiveResizeCounters {
    fn saturating_add(self, other: Self) -> Self {
        Self {
            applied: self.applied.saturating_add(other.applied),
            errors: self.errors.saturating_add(other.errors),
            fallback: self.fallback.saturating_add(other.fallback),
            received: self.received.saturating_add(other.received),
        }
    }
}

#[derive(Debug)]
struct WindowsLiveResizeHost {
    counters: WindowsLiveResizeCounters,
    generation: u64,
    last_applied_size: Option<(u32, u32)>,
    plan: Option<WindowsLiveResizePlan>,
    subclass_id: usize,
}

#[derive(Default)]
struct WindowsLiveResizeRegistry {
    hosts: HashMap<usize, WindowsLiveResizeHost>,
    surfaces: HashMap<String, WindowsLiveResizeSurface>,
}

#[derive(Clone, Copy, Debug, Default)]
struct WindowsLiveResizeObservation {
    counters: WindowsLiveResizeCounters,
    matched_latest_frame: bool,
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
                            generation,
                            last_applied_size: None,
                            plan: None,
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
                    registry.borrow_mut().surfaces.insert(
                        label,
                        WindowsLiveResizeSurface { controller, hwnd },
                    );
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
        registry
            .borrow_mut()
            .surfaces
            .insert(label, WindowsLiveResizeSurface { controller, hwnd });
    });
}

fn windows_live_resize_unregister_surface(webview: &Webview) {
    let label = webview.label().to_owned();
    let app = webview.app_handle().clone();
    let _ = app.run_on_main_thread(move || {
        WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
            registry.borrow_mut().surfaces.remove(&label);
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
            // Replacing the plan invalidates the old tab immediately. If one of
            // the new controllers has not arrived, WM_SIZE takes the worker fallback.
            host.plan = Some(plan);
            host.last_applied_size = None;
        });
    });
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
    physical_width: u32,
    physical_height: u32,
) -> WindowsLiveResizeObservation {
    let Ok(hwnd) = window.hwnd() else {
        return WindowsLiveResizeObservation::default();
    };
    WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let Some(host) = registry.hosts.get_mut(&windows_hwnd_key(hwnd)) else {
            return WindowsLiveResizeObservation::default();
        };
        let counters = std::mem::take(&mut host.counters);
        WindowsLiveResizeObservation {
            counters,
            matched_latest_frame: host.last_applied_size
                == Some((physical_width, physical_height)),
        }
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
                windows_live_resize_apply(hwnd, width, height);
            }
        }
        WM_EXITSIZEMOVE => {
            let mut client = RECT::default();
            if unsafe { GetClientRect(hwnd, &mut client) }.is_ok() {
                windows_live_resize_apply(
                    hwnd,
                    (client.right - client.left).max(1) as u32,
                    (client.bottom - client.top).max(1) as u32,
                );
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

fn windows_live_resize_apply(hwnd: HWND, physical_width: u32, physical_height: u32) {
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
                    host.last_applied_size = Some((physical_width, physical_height));
                }
            }
            Err(()) => {
                if let Some(host) = registry.hosts.get_mut(&key) {
                    host.counters.errors = host.counters.errors.saturating_add(1);
                    host.last_applied_size = None;
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

include!("live_resize_geometry.rs");
