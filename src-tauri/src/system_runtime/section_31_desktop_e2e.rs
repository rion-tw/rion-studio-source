#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub(crate) enum DesktopE2eWindowControlRequest {
    Close,
    Minimize,
    MoveResize {
        height: i32,
        scale_factor: Option<f64>,
        width: i32,
        x: i32,
        y: i32,
    },
    SetPresentation {
        presentation: String,
    },
}

impl DesktopE2eWindowControlRequest {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::MoveResize {
                height,
                scale_factor,
                width,
                ..
            } => {
                if *width <= 0 || *height <= 0 {
                    return Err("Desktop E2E window bounds must be positive.".to_owned());
                }
                if scale_factor.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                    return Err("Desktop E2E scale factor must be positive.".to_owned());
                }
                Ok(())
            }
            Self::SetPresentation { presentation }
                if !matches!(presentation.as_str(), "fullscreen" | "maximized" | "normal") =>
            {
                Err("presentation must be normal, maximized, or fullscreen".to_owned())
            }
            _ => Ok(()),
        }
    }
}

impl SystemRuntimeExecutor {
    pub(crate) fn desktop_e2e_window_snapshot(&self, window_id: &str) -> Result<Value, String> {
        let (window, target, generation, observation_sequence) = self
            .state
            .lock()
            .map_err(|_| "The runtime state is unavailable.".to_owned())?
            .native_resources
            .display_hosts
            .get(window_id)
            .map(|host| {
                (
                    host.window.clone(),
                    host.target.clone(),
                    host.generation,
                    host.last_placement_observation_sequence,
                )
            })
            .ok_or_else(|| format!("Native Game Window {window_id} is not live."))?;
        let projection = self
            .presentation
            .live
            .kernel
            .snapshot()
            .map_err(|error| error.to_string())?
            .native_projection(window_id);
        let native = desktop_e2e_native_window_snapshot(&window)?;
        let kernel = projection.map(|projection| {
            json!({
                "persistedName": projection.persisted_name,
                "placement": projection.placement,
                "revision": projection.revision,
                "selectedTabId": projection.tabs.iter().find(|tab| tab.selected).map(|tab| tab.tab_id.clone()),
                "surfaceTabIds": projection.surfaces.iter().map(|surface| surface.tab_id.clone()).collect::<Vec<_>>(),
                "tabs": projection.tabs.iter().map(|tab| json!({
                    "audioMuted": tab.audio_muted,
                    "hidden": tab.hidden,
                    "launchPhase": self.presentation.statuses.launch_phase(&tab.tab_id).map(LaunchPhase::as_str),
                    "sourceId": tab.source_id,
                    "tabId": tab.tab_id,
                    "tabType": tab.tab_type,
                    "title": tab.title,
                })).collect::<Vec<_>>(),
                "targetDisplay": projection.target_display,
                "windowGeneration": projection.window_generation,
                "windowRevision": projection.window_revision,
            })
        });
        Ok(json!({
            "kernel": kernel,
            "native": native,
            "observationSequence": observation_sequence,
            "pid": std::process::id(),
            "target": target,
            "windowGeneration": generation,
            "windowId": window_id,
        }))
    }

    pub(crate) fn desktop_e2e_control_window(
        &self,
        window_id: &str,
        request: DesktopE2eWindowControlRequest,
    ) -> Result<Value, String> {
        request.validate()?;
        let (window, generation) = self
            .state
            .lock()
            .map_err(|_| "The runtime state is unavailable.".to_owned())?
            .native_resources
            .display_hosts
            .get(window_id)
            .map(|host| (host.window.clone(), host.generation))
            .ok_or_else(|| format!("Native Game Window {window_id} is not live."))?;
        let action = desktop_e2e_window_control_name(&request);
        if matches!(request, DesktopE2eWindowControlRequest::Close) {
            crate::desktop_e2e::permit_close_confirmation_once(window.label());
        }
        desktop_e2e_apply_native_window_control(&window, &request)?;
        crate::desktop_e2e::record_event(
            "native-control-submitted",
            Some(window_id),
            Some(generation),
            None,
            json!({ "action": action }),
        );
        if matches!(request, DesktopE2eWindowControlRequest::Close) {
            Ok(json!({
                "action": action,
                "submitted": true,
                "windowGeneration": generation,
                "windowId": window_id,
            }))
        } else {
            self.desktop_e2e_window_snapshot(window_id)
        }
    }
}

fn desktop_e2e_window_control_name(request: &DesktopE2eWindowControlRequest) -> &'static str {
    match request {
        DesktopE2eWindowControlRequest::Close => "close",
        DesktopE2eWindowControlRequest::Minimize => "minimize",
        DesktopE2eWindowControlRequest::MoveResize { .. } => "moveResize",
        DesktopE2eWindowControlRequest::SetPresentation { presentation } => match presentation.as_str() {
            "fullscreen" => "fullscreen",
            "maximized" => "maximized",
            "normal" => "normal",
            _ => "invalidPresentation",
        },
    }
}

#[cfg(windows)]
fn desktop_e2e_outer_extent_for_client(
    requested_logical: i32,
    target_scale: f64,
    current_outer: i32,
    current_client: i32,
    current_scale: f64,
) -> i32 {
    let requested_client = (f64::from(requested_logical) * target_scale).round() as i32;
    let current_non_client = (current_outer - current_client).max(0);
    let target_non_client =
        (f64::from(current_non_client) * target_scale / current_scale).round() as i32;
    requested_client.saturating_add(target_non_client)
}

#[cfg(windows)]
fn desktop_e2e_apply_native_window_control(
    window: &Window,
    request: &DesktopE2eWindowControlRequest,
) -> Result<(), String> {
    use windows::Win32::UI::{
        HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{
            GetClientRect, GetWindowRect, SendMessageW, SetWindowPos, SWP_NOACTIVATE,
            SWP_NOOWNERZORDER, SWP_NOZORDER, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE,
        },
    };
    use windows::Win32::Foundation::RECT;

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    match request {
        DesktopE2eWindowControlRequest::Close => window.close().map_err(|error| error.to_string()),
        DesktopE2eWindowControlRequest::Minimize => {
            request_platform_window_minimize(window)
        }
        DesktopE2eWindowControlRequest::SetPresentation { presentation } => match presentation.as_str() {
            "normal" => {
                request_platform_window_set_fullscreen(window, false)?;
                request_platform_window_set_maximized(window, false)?;
                request_platform_window_restore(window)
            }
            "maximized" => {
                request_platform_window_set_fullscreen(window, false)?;
                request_platform_window_restore(window)?;
                request_platform_window_set_maximized(window, true)
            }
            "fullscreen" => {
                request_platform_window_restore(window)?;
                request_platform_window_set_fullscreen(window, true)
            }
            _ => Err("presentation must be normal, maximized, or fullscreen".to_owned()),
        },
        DesktopE2eWindowControlRequest::MoveResize {
            height,
            scale_factor,
            width,
            x,
            y,
        } => {
            if *width <= 0 || *height <= 0 {
                return Err("Desktop E2E window bounds must be positive.".to_owned());
            }
            request_platform_window_set_fullscreen(window, false)?;
            request_platform_window_set_maximized(window, false)?;
            request_platform_window_restore(window)?;
            let current_dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
            let scale = match scale_factor {
                Some(value) if value.is_finite() && *value > 0.0 => *value,
                Some(_) => return Err("Desktop E2E scale factor must be positive.".to_owned()),
                None => f64::from(current_dpi) / 96.0,
            };
            let current_scale = f64::from(current_dpi) / 96.0;
            let mut client = RECT::default();
            let mut outer = RECT::default();
            unsafe {
                GetClientRect(hwnd, &mut client).map_err(|error| error.to_string())?;
                GetWindowRect(hwnd, &mut outer).map_err(|error| error.to_string())?;
            }
            let outer_width = desktop_e2e_outer_extent_for_client(
                *width,
                scale,
                outer.right - outer.left,
                client.right - client.left,
                current_scale,
            );
            let outer_height = desktop_e2e_outer_extent_for_client(
                *height,
                scale,
                outer.bottom - outer.top,
                client.bottom - client.top,
                current_scale,
            );
            unsafe {
                SendMessageW(hwnd, WM_ENTERSIZEMOVE, None, None);
                let result = SetWindowPos(
                    hwnd,
                    None,
                    (f64::from(*x) * scale).round() as i32,
                    (f64::from(*y) * scale).round() as i32,
                    outer_width,
                    outer_height,
                    SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
                );
                SendMessageW(hwnd, WM_EXITSIZEMOVE, None, None);
                result.map_err(|error| error.to_string())
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn desktop_e2e_apply_native_window_control(
    window: &Window,
    request: &DesktopE2eWindowControlRequest,
) -> Result<(), String> {
    let action = match request {
        DesktopE2eWindowControlRequest::MoveResize { .. } => 0,
        DesktopE2eWindowControlRequest::SetPresentation { presentation } => match presentation.as_str() {
            "normal" => 1,
            "maximized" => 2,
            "fullscreen" => 4,
            _ => return Err("presentation must be normal, maximized, or fullscreen".to_owned()),
        },
        DesktopE2eWindowControlRequest::Minimize => 3,
        DesktopE2eWindowControlRequest::Close => 5,
    };
    let (x, y, width, height) = match request {
        DesktopE2eWindowControlRequest::MoveResize {
            height,
            width,
            x,
            y,
            ..
        } if *width > 0 && *height > 0 => (*x, *y, *width, *height),
        DesktopE2eWindowControlRequest::MoveResize { .. } => {
            return Err("Desktop E2E window bounds must be positive.".to_owned());
        }
        _ => (0, 0, 0, 0),
    };
    let raw_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let succeeded = unsafe {
                rion_desktop_e2e_control_window(
                    raw_window as *mut std::ffi::c_void,
                    action,
                    f64::from(x),
                    f64::from(y),
                    f64::from(width),
                    f64::from(height),
                )
            };
            let _ = sender.send(succeeded);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The AppKit desktop E2E control did not complete.".to_owned())?
        .then_some(())
        .ok_or_else(|| "AppKit rejected the desktop E2E window control.".to_owned())
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct DesktopE2eMacWindowSnapshot {
    content_height: f64,
    content_width: f64,
    display_id: i64,
    fullscreen: bool,
    maximized: bool,
    minimized: bool,
    outer_height: f64,
    outer_width: f64,
    outer_x: f64,
    outer_y: f64,
    scale_factor: f64,
    work_height: f64,
    work_width: f64,
    work_x: f64,
    work_y: f64,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn rion_desktop_e2e_control_window(
        window: *mut std::ffi::c_void,
        action: i32,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> bool;
    fn rion_desktop_e2e_read_window(
        window: *mut std::ffi::c_void,
        snapshot: *mut DesktopE2eMacWindowSnapshot,
    ) -> bool;
}

#[cfg(target_os = "macos")]
fn desktop_e2e_native_window_snapshot(window: &Window) -> Result<Value, String> {
    let raw_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let mut snapshot = DesktopE2eMacWindowSnapshot::default();
            let succeeded = unsafe {
                rion_desktop_e2e_read_window(
                    raw_window as *mut std::ffi::c_void,
                    &mut snapshot,
                )
            };
            let _ = sender.send(succeeded.then_some(snapshot));
        })
        .map_err(|error| error.to_string())?;
    let snapshot = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The AppKit desktop E2E readback did not complete.".to_owned())?
        .ok_or_else(|| "AppKit rejected the desktop E2E window readback.".to_owned())?;
    Ok(json!({
        "clientBounds": {
            "height": snapshot.content_height,
            "width": snapshot.content_width,
        },
        "displayId": snapshot.display_id,
        "handle": format!("0x{raw_window:x}"),
        "outerBounds": {
            "height": snapshot.outer_height,
            "width": snapshot.outer_width,
            "x": snapshot.outer_x,
            "y": snapshot.outer_y,
        },
        "presentation": if snapshot.minimized {
            "minimized"
        } else if snapshot.fullscreen {
            "fullscreen"
        } else if snapshot.maximized {
            "maximized"
        } else {
            "normal"
        },
        "scaleFactor": snapshot.scale_factor,
        "workArea": {
            "height": snapshot.work_height,
            "width": snapshot.work_width,
            "x": snapshot.work_x,
            "y": snapshot.work_y,
        },
        "title": window.title().unwrap_or_default(),
    }))
}

#[cfg(windows)]
fn desktop_e2e_native_window_snapshot(window: &Window) -> Result<Value, String> {
    use windows::Win32::{
        Foundation::{POINT, RECT},
        Graphics::Gdi::{
            ClientToScreen, GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO,
            MonitorFromWindow,
        },
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{GetClientRect, GetWindowPlacement, GetWindowRect, WINDOWPLACEMENT},
        },
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    let mut client = RECT::default();
    let mut outer = RECT::default();
    unsafe {
        GetWindowPlacement(hwnd, &mut placement).map_err(|error| error.to_string())?;
        GetClientRect(hwnd, &mut client).map_err(|error| error.to_string())?;
        GetWindowRect(hwnd, &mut outer).map_err(|error| error.to_string())?;
    }
    let mut client_origin = POINT::default();
    unsafe { ClientToScreen(hwnd, &mut client_origin) }
        .ok()
        .map_err(|error| error.to_string())?;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(monitor, &mut monitor_info) }
        .ok()
        .map_err(|error| error.to_string())?;
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    let scale = f64::from(dpi) / 96.0;
    let logical = |value: i32| f64::from(value) / scale;
    Ok(json!({
        "clientBounds": {
            "height": logical(client.bottom - client.top),
            "width": logical(client.right - client.left),
            "x": logical(client_origin.x),
            "y": logical(client_origin.y),
        },
        "dpi": dpi,
        "handle": format!("0x{:x}", hwnd.0 as usize),
        "normalOuterBounds": {
            "height": logical(placement.rcNormalPosition.bottom - placement.rcNormalPosition.top),
            "width": logical(placement.rcNormalPosition.right - placement.rcNormalPosition.left),
            "x": logical(placement.rcNormalPosition.left),
            "y": logical(placement.rcNormalPosition.top),
        },
        "outerBounds": {
            "height": logical(outer.bottom - outer.top),
            "width": logical(outer.right - outer.left),
            "x": logical(outer.left),
            "y": logical(outer.top),
        },
        "presentation": if window.is_minimized().unwrap_or(false) {
            "minimized"
        } else if window.is_fullscreen().unwrap_or(false) {
            "fullscreen"
        } else if window.is_maximized().unwrap_or(false) {
            "maximized"
        } else {
            "normal"
        },
        "scaleFactor": scale,
        "showCommand": placement.showCmd,
        "title": window.title().unwrap_or_default(),
        "workArea": {
            "height": logical(monitor_info.rcWork.bottom - monitor_info.rcWork.top),
            "width": logical(monitor_info.rcWork.right - monitor_info.rcWork.left),
            "x": logical(monitor_info.rcWork.left),
            "y": logical(monitor_info.rcWork.top),
        },
    }))
}
