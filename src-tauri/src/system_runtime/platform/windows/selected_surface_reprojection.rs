#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::system_runtime) struct WindowsSelectedSurfaceBounds {
    pub(in crate::system_runtime) bottom: i32,
    pub(in crate::system_runtime) left: i32,
    pub(in crate::system_runtime) right: i32,
    pub(in crate::system_runtime) top: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::system_runtime) struct WindowsSelectedSurfaceObservation {
    pub(in crate::system_runtime) bounds: WindowsSelectedSurfaceBounds,
    pub(in crate::system_runtime) controller_visible: bool,
    pub(in crate::system_runtime) parent_window_matches_host: bool,
}

pub(in crate::system_runtime) fn windows_observe_selected_surface(
    webview: &Webview,
    target_window: &Window,
) -> Result<WindowsSelectedSurfaceObservation, String> {
    // DeadlineBound: WebView2 owns callback liveness. Expiry is reported as indeterminate and
    // never treated as a successful observation or used to rebuild the surface.
    use windows::Win32::{
        Foundation::{HWND, RECT},
        UI::WindowsAndMessaging::{GA_ROOT, GetAncestor},
    };

    let expected_root = target_window
        .hwnd()
        .map_err(|error| error.to_string())?
        .0 as usize;
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let mut bounds = RECT::default();
            let mut controller_parent = HWND::default();
            let mut controller_visible = windows::core::BOOL::default();
            let result = (|| -> Result<WindowsSelectedSurfaceObservation, String> {
                controller
                    .ParentWindow(&mut controller_parent)
                    .map_err(|error| error.to_string())?;
                controller
                    .Bounds(&mut bounds)
                    .map_err(|error| error.to_string())?;
                controller
                    .IsVisible(&mut controller_visible)
                    .map_err(|error| error.to_string())?;
                let actual_root = GetAncestor(controller_parent, GA_ROOT);
                let expected_root = HWND(expected_root as *mut std::ffi::c_void);
                Ok(WindowsSelectedSurfaceObservation {
                    bounds: WindowsSelectedSurfaceBounds {
                        bottom: bounds.bottom,
                        left: bounds.left,
                        right: bounds.right,
                        top: bounds.top,
                    },
                    controller_visible: controller_visible.as_bool(),
                    parent_window_matches_host: actual_root == expected_root,
                })
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            "WebView2 selected-surface observation did not complete before its external acknowledgement boundary."
                .to_owned()
        })?
}

pub(in crate::system_runtime) fn windows_notify_selected_surface_parent_position(
    webview: &Webview,
) -> Result<(), String> {
    // DeadlineBound for the same external WebView2 acknowledgement boundary as observation.
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = platform_webview
                .controller()
                .NotifyParentWindowPositionChanged()
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            "WebView2 selected-surface parent-position acknowledgement is indeterminate."
                .to_owned()
        })?
}

pub(in crate::system_runtime) fn windows_force_selected_surface_bounds_projection(
    window: &Window,
    surface_labels: &[String],
) -> Result<(), String> {
    if surface_labels.is_empty() {
        return Ok(());
    }
    // DeadlineBound: the native UI callback synchronously flushes and verifies the existing
    // live-resize plan. A missing plan, failed batch, or callback expiry is terminal failure or
    // indeterminate evidence; it never becomes inferred success.
    let projection_window = window.clone();
    let surface_labels = surface_labels.to_vec();
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                let hwnd = projection_window
                    .hwnd()
                    .map_err(|error| error.to_string())?;
                let key = windows_hwnd_key(hwnd);
                let prepared = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
                    let mut registry = registry.borrow_mut();
                    let Some(host) = registry.hosts.get_mut(&key) else {
                        return false;
                    };
                    if host.plan.is_none() {
                        return false;
                    }
                    for label in &surface_labels {
                        host.last_surface_bounds.remove(label);
                    }
                    windows_live_resize_advance_epoch(host);
                    true
                });
                if !prepared {
                    return Err(
                        "The selected-surface bounds projection has no current Windows geometry plan."
                            .to_owned(),
                    );
                }
                windows_live_resize_queue_current_frame(hwnd, false);
                windows_live_resize_flush(hwnd);
                let completion = WINDOWS_LIVE_RESIZE_REGISTRY.with(|registry| {
                    registry.borrow().hosts.get(&key).map(|host| {
                        (host.last_batch_failed, host.pending_frame.is_some())
                    })
                });
                match completion {
                    Some((false, false)) => Ok(()),
                    Some((false, true)) => Err(
                        "The selected-surface Windows geometry batch did not produce a terminal native receipt."
                            .to_owned(),
                    ),
                    Some((true, _)) => Err(
                        "The selected-surface Windows geometry batch failed native verification."
                            .to_owned(),
                    ),
                    None => Err(
                        "The selected-surface Windows geometry host disappeared before verification."
                            .to_owned(),
                    ),
                }
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The selected-surface bounds projection is indeterminate.".to_owned())?
}
