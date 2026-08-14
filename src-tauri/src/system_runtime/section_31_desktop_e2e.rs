#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DesktopE2eWindowControlRequest {
    ClickVisibleClose,
    Close,
    DragVisibleChrome {
        delta_x: i32,
        delta_y: i32,
    },
    Focus,
    Minimize,
    PermitCloseConfirmation,
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
    #[cfg(windows)]
    pub(crate) fn desktop_e2e_inject_duplicate_role_cookie_checkpoint(
        &self,
        role_id: &str,
    ) -> Result<Value, String> {
        let protected = read_role_cookie_checkpoint_blob(&self.user_data_dir, role_id)
            .map_err(|error| error.message)?
            .ok_or_else(|| "The role cookie checkpoint is unavailable.".to_owned())?;
        let plaintext = rion_platform::unprotect_session_transfer(
            rion_platform::Platform::Windows,
            &protected,
        )
        .map_err(|error| error.to_string())?;
        let mut checkpoint: PersistedRoleCookieCheckpoint =
            serde_json::from_slice(&plaintext).map_err(|error| error.to_string())?;
        if checkpoint.version != ROLE_COOKIE_CHECKPOINT_VERSION {
            return Err("The role cookie checkpoint version is unsupported.".to_owned());
        }
        let (domain, path, secure) = checkpoint
            .cookies
            .iter()
            .find(|record| record.name == "rion-e2e-session")
            .map(|record| (record.domain.clone(), record.path.clone(), record.secure))
            .ok_or_else(|| "The seeded role session cookie is unavailable.".to_owned())?;
        let collision_name = "rion-e2e-checkpoint-collision";
        checkpoint.cookies.retain(|record| {
            record.name != collision_name
                || normalized_cookie_domain(record.domain.as_deref())
                    != normalized_cookie_domain(domain.as_deref())
                || record.path != path
        });
        let expires_unix_ms = OffsetDateTime::now_utc().unix_timestamp() * 1_000 + 86_400_000;
        for value in ["stale", "current"] {
            checkpoint.cookies.push(SessionCookieRecord {
                name: collision_name.to_owned(),
                value: value.to_owned(),
                domain: domain.clone(),
                path: path.clone(),
                secure,
                http_only: false,
                same_site: "strict".to_owned(),
                expires_unix_ms: Some(expires_unix_ms),
            });
        }
        let serialized = serde_json::to_vec(&checkpoint).map_err(|error| error.to_string())?;
        let protected = rion_platform::protect_session_transfer(
            rion_platform::Platform::Windows,
            &serialized,
        )
        .map_err(|error| error.to_string())?;
        let directory = role_cookie_checkpoint_directory(&self.user_data_dir, role_id)
            .map_err(|error| error.message)?;
        write_private_file(&directory, ROLE_COOKIE_CHECKPOINT_FILE, &protected)
            .map_err(|error| error.message)?;
        Ok(json!({
            "duplicateCount": 2,
            "roleId": role_id,
            "totalCookieCount": checkpoint.cookies.len(),
        }))
    }

    #[cfg(not(windows))]
    pub(crate) fn desktop_e2e_inject_duplicate_role_cookie_checkpoint(
        &self,
        _role_id: &str,
    ) -> Result<Value, String> {
        Err("Duplicate role cookie checkpoints are a Windows-only fixture.".to_owned())
    }

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
        #[cfg(windows)]
        let native = {
            let mut native = native;
            let tab_strip = self
                .state
                .lock()
                .map_err(|_| "The runtime state is unavailable.".to_owned())?
                .native_resources
                .display_hosts
                .get(window_id)
                .map(|host| host.tab_strip.clone())
                .ok_or_else(|| format!("Native Game Window {window_id} is not live."))?;
            let (tab_strip_bounds, tab_strip_host_bounds) =
                desktop_e2e_windows_tab_strip_geometry(&tab_strip)?;
            let native_object = native
                .as_object_mut()
                .ok_or_else(|| "The native window snapshot is invalid.".to_owned())?;
            native_object.insert("tabStripBounds".to_owned(), tab_strip_bounds);
            native_object.insert("tabStripHostBounds".to_owned(), tab_strip_host_bounds);
            native
        };
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
        if matches!(
            request,
            DesktopE2eWindowControlRequest::PermitCloseConfirmation
        ) {
            crate::desktop_e2e::permit_close_confirmation_once(window.label());
            crate::desktop_e2e::record_event(
                "close-confirmation-permitted",
                Some(window_id),
                Some(generation),
                None,
                json!({ "action": action }),
            );
            return self.desktop_e2e_window_snapshot(window_id);
        }
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
        if matches!(request, DesktopE2eWindowControlRequest::Focus) {
            crate::desktop_e2e::record_event(
                "window-focus-acknowledged",
                Some(window_id),
                Some(generation),
                None,
                json!({ "action": action, "status": "applied" }),
            );
        }
        if matches!(
            request,
            DesktopE2eWindowControlRequest::Close
                | DesktopE2eWindowControlRequest::ClickVisibleClose
        ) {
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

#[cfg(windows)]
fn desktop_e2e_windows_tab_strip_geometry(tab_strip: &Webview) -> Result<(Value, Value), String> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::GetClientRect},
    };

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    tab_strip
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let mut parent = HWND::default();
            let mut bounds = RECT::default();
            let mut host_bounds = RECT::default();
            let result = (|| -> Result<(Value, Value), String> {
                controller
                    .ParentWindow(&mut parent)
                    .map_err(|error| error.to_string())?;
                controller
                    .Bounds(&mut bounds)
                    .map_err(|error| error.to_string())?;
                GetClientRect(parent, &mut host_bounds).map_err(|error| error.to_string())?;
                let scale = f64::from(GetDpiForWindow(parent).max(96)) / 96.0;
                let logical = |value: i32| f64::from(value) / scale;
                Ok((
                    json!({
                        "height": logical(bounds.bottom - bounds.top),
                        "width": logical(bounds.right - bounds.left),
                        "x": logical(bounds.left),
                        "y": logical(bounds.top),
                    }),
                    json!({
                        "height": logical(host_bounds.bottom - host_bounds.top),
                        "width": logical(host_bounds.right - host_bounds.left),
                        "x": logical(host_bounds.left),
                        "y": logical(host_bounds.top),
                    }),
                ))
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The WebView2 tab-strip bounds readback did not complete.".to_owned())?
}

fn desktop_e2e_window_control_name(request: &DesktopE2eWindowControlRequest) -> &'static str {
    match request {
        DesktopE2eWindowControlRequest::ClickVisibleClose => "clickVisibleClose",
        DesktopE2eWindowControlRequest::Close => "close",
        DesktopE2eWindowControlRequest::DragVisibleChrome { .. } => "dragVisibleChrome",
        DesktopE2eWindowControlRequest::Focus => "focus",
        DesktopE2eWindowControlRequest::Minimize => "minimize",
        DesktopE2eWindowControlRequest::PermitCloseConfirmation => "permitCloseConfirmation",
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
            GetClientRect, GetWindowRect, PostMessageW, SendMessageW, SetWindowPos,
            SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER, WM_CLOSE, WM_ENTERSIZEMOVE,
            WM_EXITSIZEMOVE,
        },
    };
    use windows::Win32::Foundation::{LPARAM, RECT, WPARAM};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    match request {
        DesktopE2eWindowControlRequest::ClickVisibleClose => {
            desktop_e2e_windows_visible_chrome_pointer(window, None)
        }
        DesktopE2eWindowControlRequest::Close => unsafe {
            // Exercise the same asynchronous Win32 close request as the native
            // title-bar button. Tauri's Window::close queues another runtime
            // user event, which can strand the invoking WebView reply behind a
            // navigation-time CloseRequested callback.
            PostMessageW(
                Some(hwnd),
                WM_CLOSE,
                WPARAM::default(),
                LPARAM::default(),
            )
            .map_err(|error| error.to_string())
        },
        DesktopE2eWindowControlRequest::Minimize => {
            request_platform_window_minimize(window)
        }
        DesktopE2eWindowControlRequest::DragVisibleChrome { delta_x, delta_y } => {
            desktop_e2e_windows_visible_chrome_pointer(window, Some((*delta_x, *delta_y)))
        }
        DesktopE2eWindowControlRequest::Focus => {
            request_platform_window_show_foreground(window).map_err(|error| error.message)
        }
        DesktopE2eWindowControlRequest::PermitCloseConfirmation => Ok(()),
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

#[cfg(windows)]
fn desktop_e2e_windows_visible_chrome_pointer(
    window: &Window,
    drag_delta: Option<(i32, i32)>,
) -> Result<(), String> {
    // A Game Window is a native Window with child WebViews, so Tauri WebDriver
    // cannot select it as a WebviewWindow handle. Keep the E2E action at the
    // real Win32 pointer boundary so overlapping child HWNDs fail hit testing.
    use windows::Win32::{
        Foundation::{POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        UI::{
            HiDpi::GetDpiForWindow,
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE,
                MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
                MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, MOUSE_EVENT_FLAGS,
            },
            WindowsAndMessaging::{
                GetClientRect, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
                IsChild, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WindowFromPoint,
            },
        },
    };

    window.set_focus().map_err(|error| error.to_string())?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let mut client = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        GetClientRect(hwnd, &mut client).map_err(|error| error.to_string())?;
        ClientToScreen(hwnd, &mut origin)
            .ok()
            .map_err(|error| error.to_string())?;
    }
    let scale = f64::from(unsafe { GetDpiForWindow(hwnd) }.max(96)) / 96.0;
    let client_width = client.right.saturating_sub(client.left);
    let client_height = client.bottom.saturating_sub(client.top);
    let logical = |value: f64| (value * scale).round() as i32;
    let start = if drag_delta.is_some() {
        // The flexible #window-drag-region ends immediately before the three
        // 46px window controls and has a 12px minimum width. Aim at its center.
        POINT {
            x: origin.x + client_width - logical(150.0),
            y: origin.y + logical(20.0).min(client_height.saturating_sub(1)),
        }
    } else {
        // The visible close control is 46px wide and 40px high.
        POINT {
            x: origin.x + client_width - logical(23.0),
            y: origin.y + logical(20.0).min(client_height.saturating_sub(1)),
        }
    };
    let hit_window = unsafe { WindowFromPoint(start) };
    if hit_window != hwnd && !unsafe { IsChild(hwnd, hit_window) }.as_bool() {
        return Err("The visible Game Window pointer target is obscured.".to_owned());
    }
    let virtual_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let virtual_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let virtual_width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(2);
    let virtual_height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(2);
    let absolute = |point: POINT, flags: MOUSE_EVENT_FLAGS| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: point
                    .x
                    .saturating_sub(virtual_x)
                    .saturating_mul(65_535)
                    / virtual_width.saturating_sub(1),
                dy: point
                    .y
                    .saturating_sub(virtual_y)
                    .saturating_mul(65_535)
                    / virtual_height.saturating_sub(1),
                dwFlags: flags
                    | MOUSEEVENTF_MOVE
                    | MOUSEEVENTF_ABSOLUTE
                    | MOUSEEVENTF_VIRTUALDESK,
                ..Default::default()
            },
        },
    };
    let button = |flags: MOUSE_EVENT_FLAGS| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let mut inputs = vec![absolute(start, Default::default()), button(MOUSEEVENTF_LEFTDOWN)];
    if let Some((delta_x, delta_y)) = drag_delta {
        for step in 1..=4 {
            inputs.push(absolute(
                POINT {
                    x: start.x + logical(f64::from(delta_x)) * step / 4,
                    y: start.y + logical(f64::from(delta_y)) * step / 4,
                },
                Default::default(),
            ));
        }
    }
    inputs.push(button(MOUSEEVENTF_LEFTUP));
    let submitted = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    (submitted == inputs.len() as u32)
        .then_some(())
        .ok_or_else(|| {
            format!(
                "Windows accepted {submitted}/{} desktop E2E pointer inputs.",
                inputs.len()
            )
        })
}

#[cfg(target_os = "macos")]
fn desktop_e2e_apply_native_window_control(
    window: &Window,
    request: &DesktopE2eWindowControlRequest,
) -> Result<(), String> {
    let action = match request {
        DesktopE2eWindowControlRequest::ClickVisibleClose
        | DesktopE2eWindowControlRequest::DragVisibleChrome { .. } => {
            return Err("Visible chrome pointer controls are Windows-only.".to_owned());
        }
        DesktopE2eWindowControlRequest::MoveResize { .. } => 0,
        DesktopE2eWindowControlRequest::Focus => {
            return request_platform_window_show_foreground(window)
                .map_err(|error| error.message);
        }
        DesktopE2eWindowControlRequest::SetPresentation { presentation } => match presentation.as_str() {
            "normal" => 1,
            "maximized" => 2,
            "fullscreen" => 4,
            _ => return Err("presentation must be normal, maximized, or fullscreen".to_owned()),
        },
        DesktopE2eWindowControlRequest::Minimize => 3,
        DesktopE2eWindowControlRequest::PermitCloseConfirmation => return Ok(()),
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
