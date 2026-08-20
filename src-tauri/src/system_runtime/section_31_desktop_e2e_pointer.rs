#[cfg(windows)]
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopE2eTabClientRect {
    bottom: f64,
    left: f64,
    right: f64,
    top: f64,
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
struct DesktopE2eTabScreenRect {
    bottom: i32,
    left: i32,
    parent: usize,
    right: i32,
    top: i32,
}

#[cfg(windows)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopE2eWindowChromeRectMessage {
    client_x: Option<f64>,
    client_y: Option<f64>,
    event: Option<String>,
    kind: String,
    minimize: Option<DesktopE2eTabClientRect>,
    target_id: Option<String>,
}

#[cfg(windows)]
static DESKTOP_E2E_WINDOWS_CHROME_RECTS:
    std::sync::OnceLock<std::sync::Mutex<HashMap<String, DesktopE2eTabClientRect>>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn desktop_e2e_windows_chrome_rects(
) -> &'static std::sync::Mutex<HashMap<String, DesktopE2eTabClientRect>> {
    DESKTOP_E2E_WINDOWS_CHROME_RECTS.get_or_init(Default::default)
}

#[cfg(windows)]
fn desktop_e2e_windows_tab_chrome_probe_script() -> &'static str {
    r##"(() => {
  const publish = () => {
    const element = document.querySelector("#window-minimize");
    if (!element || element.hidden || element.getClientRects().length !== 1) return;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return;
    globalThis.chrome?.webview?.postMessage(JSON.stringify({
      kind: "rion-desktop-e2e-window-chrome-v1",
      minimize: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }));
  };
  addEventListener("DOMContentLoaded", publish, { once: true });
  addEventListener("resize", publish);
  for (const eventName of ["pointerdown", "pointerup", "click"]) {
    addEventListener(eventName, (event) => {
      globalThis.chrome?.webview?.postMessage(JSON.stringify({
        clientX: event.clientX,
        clientY: event.clientY,
        event: eventName,
        kind: "rion-desktop-e2e-window-chrome-v1",
        targetId: event.target instanceof Element ? event.target.closest("[id]")?.id ?? null : null
      }));
    }, true);
  }
})();"##
}

#[cfg(windows)]
fn desktop_e2e_windows_register_tab_chrome_channel(tab_strip: &Webview) -> Result<(), String> {
    use webview2_com::{
        CoTaskMemPWSTR, WebMessageReceivedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::PWSTR;

    let label = tab_strip.label().to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    tab_strip
        .with_webview(move |platform_webview| {
            let result = (|| -> Result<(), String> {
                let core: ICoreWebView2 = unsafe { platform_webview.controller().CoreWebView2() }
                    .map_err(|error| error.to_string())?;
                let handler = WebMessageReceivedEventHandler::create(Box::new(
                    move |_webview, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut raw = PWSTR::null();
                        if unsafe { args.TryGetWebMessageAsString(&mut raw) }.is_err() {
                            return Ok(());
                        }
                        let message = CoTaskMemPWSTR::from(raw).to_string();
                        let Ok(message) =
                            serde_json::from_str::<DesktopE2eWindowChromeRectMessage>(&message)
                        else {
                            return Ok(());
                        };
                        if message.kind != "rion-desktop-e2e-window-chrome-v1" {
                            return Ok(());
                        }
                        if message.event.as_deref().is_some_and(|event| {
                            matches!(event, "click" | "pointerdown" | "pointerup")
                        }) {
                            crate::desktop_e2e::record_event(
                                "visible-chrome-pointer-observed",
                                None,
                                None,
                                None,
                                json!({
                                    "clientX": message.client_x,
                                    "clientY": message.client_y,
                                    "event": message.event,
                                    "tabStripLabel": label,
                                    "targetId": message.target_id,
                                }),
                            );
                            return Ok(());
                        }
                        let Some(rect) = message.minimize else {
                            return Ok(());
                        };
                        if !rect.left.is_finite()
                            || !rect.top.is_finite()
                            || !rect.right.is_finite()
                            || !rect.bottom.is_finite()
                            || rect.right <= rect.left
                            || rect.bottom <= rect.top
                        {
                            return Ok(());
                        }
                        if let Ok(mut rects) = desktop_e2e_windows_chrome_rects().lock() {
                            rects.insert(label.clone(), rect);
                        }
                        Ok(())
                    },
                ));
                let mut token = 0;
                unsafe { core.add_WebMessageReceived(&handler, &mut token) }
                    .map_err(|error| error.to_string())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The WebView2 window-control event channel did not attach.".to_owned())?
}

#[cfg(windows)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopE2ePointerTraceEvent {
    client_x: i32,
    client_y: i32,
    event_type: String,
    target_tab_id: Option<String>,
}

#[cfg(windows)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopE2ePointerTrace {
    active_tab_id: Option<String>,
    events: Vec<DesktopE2ePointerTraceEvent>,
    order: Vec<String>,
    sort_active: bool,
}

#[cfg(windows)]
fn desktop_e2e_windows_execute_json<T>(webview: &Webview, script: String) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
{
    use webview2_com::{
        ExecuteScriptCompletedHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::HSTRING;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> Result<(), String> {
                let core: ICoreWebView2 = platform_webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| error.to_string())?;
                let completion_sender = sender.clone();
                let handler = ExecuteScriptCompletedHandler::create(Box::new(move |status, raw| {
                    let result = status
                        .map_err(|error| error.to_string())
                        .and_then(|()| {
                            serde_json::from_str::<T>(&raw.to_string())
                                .map_err(|error| error.to_string())
                        });
                    let _ = completion_sender.send(result);
                    Ok(())
                }));
                core.ExecuteScript(&HSTRING::from(script), &handler)
                    .map_err(|error| error.to_string())
            })();
            if let Err(error) = result {
                let _ = sender.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The WebView2 pointer observation did not complete.".to_owned())?
}

#[cfg(windows)]
fn desktop_e2e_windows_install_pointer_trace(
    tab_strip: &Webview,
    terminal_nonce: &str,
    terminal_event: &str,
) -> Result<(), String> {
    let terminal_nonce = serde_json::to_string(terminal_nonce).map_err(|error| error.to_string())?;
    let terminal_event = serde_json::to_string(terminal_event).map_err(|error| error.to_string())?;
    desktop_e2e_windows_execute_json::<bool>(
        tab_strip,
        format!(
            "(() => {{ globalThis.__rionDesktopE2ePointerTrace?.controller.abort(); const controller = new AbortController(); const events = []; const terminalEvent = {terminal_event}; for (const eventType of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'contextmenu']) document.addEventListener(eventType, (event) => {{ events.push({{ clientX: Math.round(event.clientX), clientY: Math.round(event.clientY), eventType, targetTabId: event.target instanceof Element ? event.target.closest('button.tab')?.dataset.tabId ?? null : null }}); if (eventType === terminalEvent) queueMicrotask(() => window.chrome.webview.postMessage({terminal_nonce})); }}, {{ capture: true, signal: controller.signal }}); globalThis.__rionDesktopE2ePointerTrace = {{ controller, events }}; return true; }})()"
        ),
    )
    .map(|_| ())
}

#[cfg(windows)]
fn desktop_e2e_windows_pointer_terminal(
    tab_strip: &Webview,
    terminal_nonce: &str,
) -> Result<(std::sync::mpsc::Receiver<Result<(), String>>, i64), String> {
    use webview2_com::{
        CoTaskMemPWSTR, WebMessageReceivedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::PWSTR;

    let expected = terminal_nonce.to_owned();
    let (terminal_sender, terminal_receiver) = std::sync::mpsc::sync_channel(1);
    let (setup_sender, setup_receiver) = std::sync::mpsc::sync_channel(1);
    tab_strip
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> Result<i64, String> {
                let core: ICoreWebView2 = platform_webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| error.to_string())?;
                let handler = WebMessageReceivedEventHandler::create(Box::new(
                    move |_webview, args| {
                        let result = (|| -> Result<(), String> {
                            let args = args.ok_or_else(|| {
                                "The WebView2 pointer terminal omitted its arguments.".to_owned()
                            })?;
                            let mut raw = PWSTR::null();
                            args.TryGetWebMessageAsString(&mut raw)
                                .map_err(|error| error.to_string())?;
                            let message = CoTaskMemPWSTR::from(raw).to_string();
                            if message == expected {
                                let _ = terminal_sender.send(Ok(()));
                            }
                            Ok(())
                        })();
                        if let Err(error) = result {
                            let _ = terminal_sender.send(Err(error));
                        }
                        Ok(())
                    },
                ));
                let mut token = 0;
                core.add_WebMessageReceived(&handler, &mut token)
                    .map_err(|error| error.to_string())?;
                Ok(token)
            })();
            let _ = setup_sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    let token = setup_receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The WebView2 pointer-terminal registration did not complete.".to_owned())??;
    Ok((terminal_receiver, token))
}

#[cfg(windows)]
fn desktop_e2e_windows_remove_pointer_terminal(
    tab_strip: &Webview,
    token: i64,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    tab_strip
        .with_webview(move |platform_webview| unsafe {
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .map_err(|error| error.to_string())
                .and_then(|core: ICoreWebView2| {
                    core.remove_WebMessageReceived(token)
                        .map_err(|error| error.to_string())
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The WebView2 pointer-terminal removal did not complete.".to_owned())?
}

#[cfg(windows)]
fn desktop_e2e_windows_take_pointer_trace(
    tab_strip: &Webview,
) -> Result<DesktopE2ePointerTrace, String> {
    desktop_e2e_windows_execute_json(
        tab_strip,
        "(() => { const trace = globalThis.__rionDesktopE2ePointerTrace; trace?.controller.abort(); delete globalThis.__rionDesktopE2ePointerTrace; return { activeTabId: document.querySelector('button.tab.active')?.dataset.tabId ?? null, events: trace?.events ?? [], order: [...document.querySelectorAll('button.tab')].map((tab) => tab.dataset.tabId), sortActive: document.querySelector('#tabs')?.classList.contains('runtime-tab-sort-active') ?? false }; })()".to_owned(),
    )
}

#[cfg(windows)]
fn desktop_e2e_windows_tab_screen_rect(
    tab_strip: &Webview,
    tab_id: &str,
) -> Result<DesktopE2eTabScreenRect, String> {
    use windows::core::HSTRING;

    let encoded = serde_json::to_string(tab_id).map_err(|error| error.to_string())?;
    let script = HSTRING::from(format!(
        "(() => {{ const id = {encoded}; const button = [...document.querySelectorAll('button.tab')].find((candidate) => candidate.dataset.tabId === id); if (!button || button.hidden || button.getClientRects().length !== 1) return null; const style = getComputedStyle(button); const rect = button.getBoundingClientRect(); if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0) return null; return {{ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }}; }})()"
    ));
    desktop_e2e_windows_element_screen_rect(
        tab_strip,
        script,
        "The requested WebView2 runtime tab is not visible.",
        "The WebView2 runtime-tab rectangle readback did not complete.",
    )
}

#[cfg(windows)]
fn desktop_e2e_windows_minimize_screen_rect(
    tab_strip: &Webview,
) -> Result<DesktopE2eTabScreenRect, String> {
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        UI::HiDpi::GetDpiForWindow,
    };

    let rect = desktop_e2e_windows_chrome_rects()
        .lock()
        .map_err(|_| "The WebView2 window-control rectangle cache is unavailable.".to_owned())?
        .get(tab_strip.label())
        .copied()
        .ok_or_else(|| "The WebView2 minimize control has not published its rectangle.".to_owned())?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    tab_strip
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let mut parent = HWND::default();
            let mut bounds = RECT::default();
            let result = (|| -> Result<DesktopE2eTabScreenRect, String> {
                controller
                    .ParentWindow(&mut parent)
                    .map_err(|error| error.to_string())?;
                controller
                    .Bounds(&mut bounds)
                    .map_err(|error| error.to_string())?;
                let mut origin = POINT::default();
                ClientToScreen(parent, &mut origin)
                    .ok()
                    .map_err(|error| error.to_string())?;
                let scale = f64::from(GetDpiForWindow(parent).max(96)) / 96.0;
                let screen = |value: f64, offset: i32, host: i32| {
                    offset + host + (value * scale).round() as i32
                };
                Ok(DesktopE2eTabScreenRect {
                    bottom: screen(rect.bottom, origin.y, bounds.top),
                    left: screen(rect.left, origin.x, bounds.left),
                    parent: parent.0 as usize,
                    right: screen(rect.right, origin.x, bounds.left),
                    top: screen(rect.top, origin.y, bounds.top),
                })
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    let resolved = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The WebView2 minimize-control bounds readback did not complete.".to_owned())??;
    crate::desktop_e2e::record_event(
        "window-chrome-pointer-target-resolved",
        None,
        None,
        None,
        json!({
            "cssRect": {
                "bottom": rect.bottom,
                "left": rect.left,
                "right": rect.right,
                "top": rect.top,
            },
            "screenRect": {
                "bottom": resolved.bottom,
                "left": resolved.left,
                "right": resolved.right,
                "top": resolved.top,
            },
            "tabStripLabel": tab_strip.label(),
        }),
    );
    Ok(resolved)
}

#[cfg(windows)]
fn desktop_e2e_windows_element_screen_rect(
    tab_strip: &Webview,
    script: windows::core::HSTRING,
    unavailable_message: &'static str,
    timeout_message: &'static str,
) -> Result<DesktopE2eTabScreenRect, String> {
    use webview2_com::{
        ExecuteScriptCompletedHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::{
        Win32::{
            Foundation::{HWND, POINT, RECT},
            Graphics::Gdi::ClientToScreen,
            UI::HiDpi::GetDpiForWindow,
        },
    };

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    tab_strip
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let mut parent = HWND::default();
            let mut bounds = RECT::default();
            let result = (|| -> Result<(), String> {
                controller
                    .ParentWindow(&mut parent)
                    .map_err(|error| error.to_string())?;
                controller
                    .Bounds(&mut bounds)
                    .map_err(|error| error.to_string())?;
                let core: ICoreWebView2 = controller.CoreWebView2().map_err(|error| error.to_string())?;
                let completion_sender = sender.clone();
                let handler = ExecuteScriptCompletedHandler::create(Box::new(move |status, raw| {
                    let result = status
                        .map_err(|error| error.to_string())
                        .map(|()| raw.to_string())
                        .and_then(|value| {
                            serde_json::from_str::<Option<DesktopE2eTabClientRect>>(&value)
                                .map_err(|error| error.to_string())?
                                .ok_or_else(|| unavailable_message.to_owned())
                        })
                        .and_then(|rect| {
                            let mut origin = POINT::default();
                            ClientToScreen(parent, &mut origin)
                                .ok()
                                .map_err(|error| error.to_string())?;
                            let scale = f64::from(GetDpiForWindow(parent).max(96)) / 96.0;
                            let screen = |value: f64, offset: i32, host: i32| {
                                offset + host + (value * scale).round() as i32
                            };
                            Ok(DesktopE2eTabScreenRect {
                                bottom: screen(rect.bottom, origin.y, bounds.top),
                                left: screen(rect.left, origin.x, bounds.left),
                                parent: parent.0 as usize,
                                right: screen(rect.right, origin.x, bounds.left),
                                top: screen(rect.top, origin.y, bounds.top),
                            })
                        });
                    let _ = completion_sender.send(result);
                    Ok(())
                }));
                core.ExecuteScript(&script, &handler)
                    .map_err(|error| error.to_string())
            })();
            if let Err(error) = result {
                let _ = sender.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| timeout_message.to_owned())?
}

#[cfg(windows)]
fn desktop_e2e_windows_set_pointer_target_topmost(
    hwnd: windows::Win32::Foundation::HWND,
    topmost: bool,
) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetWindowLongPtrW, SetForegroundWindow, SetWindowPos, GWL_EXSTYLE,
        HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
        SWP_SHOWWINDOW, WS_EX_TOPMOST,
    };

    let base_flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW;
    let flags = if topmost {
        base_flags
    } else {
        base_flags | SWP_NOACTIVATE
    };
    unsafe {
        SetWindowPos(
            hwnd,
            Some(if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST }),
            0,
            0,
            0,
            0,
            flags,
        )
    }
    .map_err(|error| {
        format!(
            "Windows could not {} the temporary runtime-tab pointer z-order: {error}",
            if topmost { "apply" } else { "restore" }
        )
    })?;
    if topmost {
        unsafe { BringWindowToTop(hwnd) }.map_err(|error| {
            format!("Windows could not raise the temporary runtime-tab pointer target: {error}")
        })?;
        let _ = unsafe { SetForegroundWindow(hwnd) };
    }
    let is_topmost = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32
        & WS_EX_TOPMOST.0
        == WS_EX_TOPMOST.0;
    if is_topmost != topmost {
        return Err(format!(
            "Windows did not acknowledge the temporary runtime-tab pointer z-order (expectedTopmost={topmost}, actualTopmost={is_topmost})."
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn desktop_e2e_windows_submit_mouse(
    window: &Window,
    start: windows::Win32::Foundation::POINT,
    expected_parent: usize,
    end: Option<windows::Win32::Foundation::POINT>,
    right_click: bool,
    movement_barrier: Option<(&Webview, &str)>,
    dispatch_barrier: Option<&std::sync::mpsc::Receiver<Result<(), String>>>,
) -> Result<(), String> {
    use windows::Win32::{
        Foundation::POINT,
        UI::{
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE,
                MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
                MOUSEEVENTF_MOVE_NOCOALESCE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
                MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, MOUSE_EVENT_FLAGS,
            },
            WindowsAndMessaging::{
                GetAncestor, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect,
                GetSystemMetrics, IsChild, IsWindowVisible, WindowFromPoint, GA_ROOT,
                GA_ROOTOWNER, GWL_EXSTYLE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
                SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
            },
        },
    };

    request_platform_window_show_foreground(window).map_err(|error| error.message)?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    desktop_e2e_windows_set_pointer_target_topmost(hwnd, true)?;
    let pointer_result = (|| -> Result<(), String> {
        let hit = unsafe { WindowFromPoint(start) };
        let parent = windows::Win32::Foundation::HWND(
            expected_parent as *mut std::ffi::c_void,
        );
        let hit_root = unsafe { GetAncestor(hit, GA_ROOT) };
        let hit_owner_root = unsafe { GetAncestor(hit, GA_ROOTOWNER) };
        let parent_root = unsafe { GetAncestor(parent, GA_ROOT) };
        let belongs_to_window = hit == hwnd || unsafe { IsChild(hwnd, hit) }.as_bool();
        let belongs_to_tab_surface = hit == parent
            || unsafe { IsChild(parent, hit) }.as_bool()
            || (!parent_root.is_invalid() && hit_root == parent_root);
        if !belongs_to_window && !belongs_to_tab_surface {
            let mut window_rect = windows::Win32::Foundation::RECT::default();
            let rect_status = unsafe { GetWindowRect(hwnd, &mut window_rect) }.is_ok();
            let extended_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
            let is_topmost = extended_style & WS_EX_TOPMOST.0 == WS_EX_TOPMOST.0;
            let is_transparent =
                extended_style & WS_EX_TRANSPARENT.0 == WS_EX_TRANSPARENT.0;
            let foreground = unsafe { GetForegroundWindow() };
            let dwm_cloaked = windows_runtime_window_cloaked_status(window)
                .map(|mask| format!("0x{mask:x}"))
                .unwrap_or_else(|error| format!("read-failed:{}", error.code));
            return Err(format!(
                "The requested native runtime tab is obscured (target=0x{:x}, parent=0x{:x}, parentRoot=0x{:x}, hit=0x{:x}, hitRoot=0x{:x}, hitOwnerRoot=0x{:x}, foreground=0x{:x}, visible={}, topmost={}, transparent={}, dwmCloaked={}, exStyle=0x{:x}, rectStatus={}, rect={},{},{},{}, point={},{}).",
                hwnd.0 as usize,
                parent.0 as usize,
                parent_root.0 as usize,
                hit.0 as usize,
                hit_root.0 as usize,
                hit_owner_root.0 as usize,
                foreground.0 as usize,
                unsafe { IsWindowVisible(hwnd) }.as_bool(),
                is_topmost,
                is_transparent,
                dwm_cloaked,
                extended_style,
                rect_status,
                window_rect.left,
                window_rect.top,
                window_rect.right,
                window_rect.bottom,
                start.x,
                start.y,
            ));
        }
    let virtual_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let virtual_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let virtual_width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(2);
    let virtual_height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(2);
    let absolute = |point: POINT| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: point.x.saturating_sub(virtual_x).saturating_mul(65_535)
                    / virtual_width.saturating_sub(1),
                dy: point.y.saturating_sub(virtual_y).saturating_mul(65_535)
                    / virtual_height.saturating_sub(1),
                dwFlags: MOUSEEVENTF_MOVE
                    | MOUSEEVENTF_ABSOLUTE
                    | MOUSEEVENTF_MOVE_NOCOALESCE
                    | MOUSEEVENTF_VIRTUALDESK,
                ..Default::default()
            },
        },
    };
    let button = |flags: MOUSE_EVENT_FLAGS| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dwFlags: flags, ..Default::default() },
        },
    };
    let (down, up) = if right_click {
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    } else {
        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    };
    let mut inputs = vec![absolute(start), button(down)];
    if let Some(end) = end {
        for step in 1..=8 {
            inputs.push(absolute(POINT {
                x: start.x + (end.x - start.x) * step / 8,
                y: start.y + (end.y - start.y) * step / 8,
            }));
        }
    }
    let submit = |pending: &[INPUT]| {
        let submitted = unsafe { SendInput(pending, std::mem::size_of::<INPUT>() as i32) };
        (submitted == pending.len() as u32).then_some(()).ok_or_else(|| {
            format!(
                "Windows accepted {submitted}/{} runtime-tab pointer inputs.",
                pending.len()
            )
        })
    };
    if let Some((barrier_strip, barrier_tab_id)) = movement_barrier {
        submit(&inputs)?;
        let barrier_result = desktop_e2e_windows_tab_screen_rect(
            barrier_strip,
            barrier_tab_id,
        )
        .map(|_| ());
        let release_result = submit(&[button(up)]);
        barrier_result.and(release_result)?;
    } else {
        inputs.push(button(up));
        submit(&inputs)?;
    }
    if let Some(receiver) = dispatch_barrier {
        receiver
            .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
            .map_err(|_| "The native runtime-tab pointer dispatch was not acknowledged.".to_owned())??;
    }
    Ok(())
    })();
    let restore_result = desktop_e2e_windows_set_pointer_target_topmost(hwnd, false);
    pointer_result.and(restore_result)
}

#[cfg(windows)]
fn desktop_e2e_windows_webview_screen_rect(
    webview: &Webview,
) -> Result<DesktopE2eTabScreenRect, String> {
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Gdi::ClientToScreen,
    };

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let mut parent = HWND::default();
            let mut bounds = RECT::default();
            let result = (|| -> Result<DesktopE2eTabScreenRect, String> {
                controller
                    .ParentWindow(&mut parent)
                    .map_err(|error| error.to_string())?;
                controller
                    .Bounds(&mut bounds)
                    .map_err(|error| error.to_string())?;
                let mut origin = POINT::default();
                ClientToScreen(parent, &mut origin)
                    .ok()
                    .map_err(|error| error.to_string())?;
                Ok(DesktopE2eTabScreenRect {
                    bottom: origin.y + bounds.bottom,
                    left: origin.x + bounds.left,
                    parent: parent.0 as usize,
                    right: origin.x + bounds.right,
                    top: origin.y + bounds.top,
                })
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The WebView2 divider bounds readback did not complete.".to_owned())?
}

#[cfg(windows)]
fn desktop_e2e_drag_workspace_divider(
    window: &Window,
    divider: &Webview,
    axis: &str,
    delta_ratio: f64,
) -> Result<(), String> {
    use windows::Win32::Foundation::POINT;

    let rect = desktop_e2e_windows_webview_screen_rect(divider)?;
    let content = window.inner_size().map_err(|error| error.to_string())?;
    let delta = if axis == "vertical" {
        (f64::from(content.width) * delta_ratio).round() as i32
    } else if axis == "horizontal" {
        (f64::from(content.height) * delta_ratio).round() as i32
    } else {
        return Err("The runtime divider axis is invalid.".to_owned());
    };
    let start = POINT {
        x: (rect.left + rect.right) / 2,
        y: (rect.top + rect.bottom) / 2,
    };
    let end = if axis == "vertical" {
        POINT {
            x: start.x + delta,
            y: start.y,
        }
    } else {
        POINT {
            x: start.x,
            y: start.y + delta,
        }
    };
    desktop_e2e_windows_submit_mouse(
        window,
        start,
        rect.parent,
        Some(end),
        false,
        None,
        None,
    )
}

#[cfg(target_os = "macos")]
fn desktop_e2e_drag_workspace_divider(
    _window: &Window,
    divider: &Webview,
    axis: &str,
    delta_ratio: f64,
) -> Result<(), String> {
    unsafe extern "C" {
        fn rion_desktop_e2e_drag_webview(
            webview: *mut std::ffi::c_void,
            vertical: bool,
            delta_ratio: f64,
        ) -> bool;
    }
    let vertical = match axis {
        "vertical" => true,
        "horizontal" => false,
        _ => return Err("The runtime divider axis is invalid.".to_owned()),
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    divider
        .with_webview(move |platform_webview| {
            let accepted = unsafe {
                rion_desktop_e2e_drag_webview(
                    platform_webview.inner(),
                    vertical,
                    delta_ratio,
                )
            };
            let _ = sender.send(accepted);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The AppKit divider pointer dispatch did not complete.".to_owned())?
        .then_some(())
        .ok_or_else(|| "AppKit rejected the visible divider pointer drag.".to_owned())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn desktop_e2e_drag_workspace_divider(
    _window: &Window,
    _divider: &Webview,
    _axis: &str,
    _delta_ratio: f64,
) -> Result<(), String> {
    Err("Desktop E2E divider dragging requires macOS or Windows.".to_owned())
}

#[cfg(windows)]
fn desktop_e2e_windows_click_runtime_tab(
    window: &Window,
    tab_strip: &Webview,
    tab_id: &str,
    right_click: bool,
) -> Result<(), String> {
    use windows::Win32::Foundation::POINT;
    let rect = desktop_e2e_windows_tab_screen_rect(tab_strip, tab_id)?;
    static NEXT_CLICK_TERMINAL: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(1);
    let terminal_event = if right_click { "contextmenu" } else { "click" };
    let terminal_nonce = format!(
        "rion-desktop-e2e-{terminal_event}-{}",
        NEXT_CLICK_TERMINAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let (terminal_receiver, terminal_token) =
        desktop_e2e_windows_pointer_terminal(tab_strip, &terminal_nonce)?;
    if let Err(error) =
        desktop_e2e_windows_install_pointer_trace(tab_strip, &terminal_nonce, terminal_event)
    {
        let _ = desktop_e2e_windows_remove_pointer_terminal(tab_strip, terminal_token);
        return Err(error);
    }
    let pointer_result = desktop_e2e_windows_submit_mouse(
        window,
        POINT { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 },
        rect.parent,
        None,
        right_click,
        None,
        Some(&terminal_receiver),
    );
    let removal_result = desktop_e2e_windows_remove_pointer_terminal(tab_strip, terminal_token);
    let trace_result = desktop_e2e_windows_take_pointer_trace(tab_strip);
    pointer_result?;
    removal_result?;
    let trace = trace_result?;
    if trace.events.iter().any(|event| {
        event.event_type == terminal_event && event.target_tab_id.as_deref() == Some(tab_id)
    }) {
        Ok(())
    } else {
        Err(format!(
            "The native runtime-tab {terminal_event} terminal did not target the fenced tab."
        ))
    }
}

#[cfg(windows)]
fn desktop_e2e_windows_drag_runtime_tab(
    source_window: &Window,
    source_strip: &Webview,
    tab_id: &str,
    target_strip: &Webview,
    before_tab_id: Option<&str>,
) -> Result<(), String> {
    use windows::Win32::Foundation::POINT;
    let source = desktop_e2e_windows_tab_screen_rect(source_strip, tab_id)?;
    let target_id = before_tab_id.ok_or_else(|| {
        "A fenced target tab is required for the native drag destination.".to_owned()
    })?;
    let target = desktop_e2e_windows_tab_screen_rect(target_strip, target_id)?;
    static NEXT_POINTER_TERMINAL: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(1);
    let terminal_nonce = format!(
        "rion-desktop-e2e-pointer-up-{}",
        NEXT_POINTER_TERMINAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let (terminal_receiver, terminal_token) =
        desktop_e2e_windows_pointer_terminal(source_strip, &terminal_nonce)?;
    if let Err(error) =
        desktop_e2e_windows_install_pointer_trace(source_strip, &terminal_nonce, "mouseup")
    {
        let _ = desktop_e2e_windows_remove_pointer_terminal(source_strip, terminal_token);
        return Err(error);
    }
    let pointer_result = desktop_e2e_windows_submit_mouse(
        source_window,
        POINT { x: (source.left + source.right) / 2, y: (source.top + source.bottom) / 2 },
        source.parent,
        Some(POINT { x: target.left + 2, y: (target.top + target.bottom) / 2 }),
        false,
        Some((target_strip, target_id)),
        Some(&terminal_receiver),
    );
    let removal_result = desktop_e2e_windows_remove_pointer_terminal(
        source_strip,
        terminal_token,
    );
    pointer_result?;
    removal_result?;
    let trace = desktop_e2e_windows_take_pointer_trace(source_strip)?;
    let event_summary = trace
        .events
        .iter()
        .map(|event| {
            format!(
                "{}@{},{}:{:?}",
                event.event_type, event.client_x, event.client_y, event.target_tab_id
            )
        })
        .collect::<Vec<_>>();
    let dragged_index = trace.order.iter().position(|candidate| candidate == tab_id);
    let target_index = trace
        .order
        .iter()
        .position(|candidate| candidate == target_id);
    if dragged_index.is_some_and(|index| target_index.is_some_and(|target| index < target)) {
        return Ok(());
    }
    Err(format!(
        "The native runtime-tab drag did not reach its visible DOM destination (active={:?}, order={:?}, sortActive={}, events={:?}).",
        trace.active_tab_id, trace.order, trace.sort_active, event_summary
    ))
}

#[cfg(windows)]
struct DesktopE2eWindowsMenuInputPlan {
    action: String,
    expected_thread_id: u32,
    key_codes: Vec<u16>,
    window_id: String,
}

#[cfg(windows)]
static DESKTOP_E2E_WINDOWS_MENU_INPUT_PLAN: std::sync::OnceLock<
    std::sync::Mutex<Option<DesktopE2eWindowsMenuInputPlan>>,
> = std::sync::OnceLock::new();

#[cfg(windows)]
fn desktop_e2e_windows_tab_menu_key_codes(
    action: &str,
    target_rank: Option<usize>,
) -> Result<Vec<u16>, String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_DOWN, VK_HOME, VK_RETURN, VK_RIGHT,
    };
    // A freshly tracked Win32 menu has no selected item. HOME is ignored in that state, so a
    // leading DOWN first establishes visible keyboard selection before HOME normalizes the
    // sequence to the first actionable item.
    let mut presses = vec![VK_DOWN.0, VK_HOME.0];
    match action {
        "hide" => presses.extend(std::iter::repeat_n(VK_DOWN.0, 4)),
        "moveToNewWindow" => presses.extend(std::iter::repeat_n(VK_DOWN.0, 2)),
        "move" => {
            presses.push(VK_DOWN.0);
            presses.push(VK_RIGHT.0);
            // The newly opened move submenu also begins without a selection. DOWN chooses the
            // first enabled destination (the current window entry is disabled), after which the
            // rank is relative to the remaining visible destinations.
            presses.push(VK_DOWN.0);
            presses.extend(std::iter::repeat_n(
                VK_DOWN.0,
                target_rank.unwrap_or(0),
            ));
        }
        _ => return Err("The runtime tab menu action is invalid.".to_owned()),
    }
    presses.push(VK_RETURN.0);
    Ok(presses)
}

#[cfg(windows)]
unsafe extern "system" fn desktop_e2e_windows_menu_popup_started(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    event: u32,
    window: windows::Win32::Foundation::HWND,
    _object_id: i32,
    _child_id: i32,
    event_thread_id: u32,
    _event_time: u32,
) {
    use windows::Win32::{
        UI::{
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
                VIRTUAL_KEY,
            },
            WindowsAndMessaging::{
                EVENT_SYSTEM_MENUPOPUPSTART, GetWindowThreadProcessId, PostQuitMessage,
            },
        },
    };

    if event != EVENT_SYSTEM_MENUPOPUPSTART || window.0.is_null() {
        return;
    }
    let mut process_id = 0_u32;
    let observed_thread_id = unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    if process_id != std::process::id() {
        return;
    }
    let plan = DESKTOP_E2E_WINDOWS_MENU_INPUT_PLAN
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .ok()
        .and_then(|mut plan| {
            let matches_owner = plan.as_ref().is_some_and(|plan| {
                plan.expected_thread_id == event_thread_id
                    || plan.expected_thread_id == observed_thread_id
            });
            matches_owner.then(|| plan.take()).flatten()
        });
    let Some(plan) = plan else {
        return;
    };
    let key = |virtual_key: u16, key_up| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(virtual_key),
                dwFlags: if key_up { KEYEVENTF_KEYUP } else { Default::default() },
                ..Default::default()
            },
        },
    };
    let inputs = plan
        .key_codes
        .iter()
        .flat_map(|virtual_key| [key(*virtual_key, false), key(*virtual_key, true)])
        .collect::<Vec<_>>();
    let submitted = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    let applied = submitted == inputs.len() as u32;
    crate::desktop_e2e::record_event(
        "runtime-tab-menu-input-terminal",
        Some(&plan.window_id),
        None,
        None,
        serde_json::json!({
            "action": plan.action,
            "nativeEvent": "EVENT_SYSTEM_MENUPOPUPSTART",
            "status": if applied { "applied" } else { "failed" },
            "submittedInputCount": submitted,
            "totalInputCount": inputs.len(),
        }),
    );
    unsafe { PostQuitMessage(0) };
}

#[cfg(windows)]
fn desktop_e2e_windows_arm_tab_menu_item(
    owner: &Window,
    window_id: &str,
    action: &str,
    target_rank: Option<usize>,
) -> Result<(), String> {
    use windows::Win32::{
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent},
            WindowsAndMessaging::{
                EVENT_SYSTEM_MENUPOPUPSTART, GetMessageW, GetWindowThreadProcessId, MSG,
                WINEVENT_OUTOFCONTEXT,
            },
        },
    };

    let owner = owner.hwnd().map_err(|error| error.to_string())?;
    let mut process_id = 0_u32;
    let expected_thread_id = unsafe { GetWindowThreadProcessId(owner, Some(&mut process_id)) };
    if expected_thread_id == 0 || process_id != std::process::id() {
        return Err("The native runtime-tab menu owner is stale.".to_owned());
    }
    let plan = DesktopE2eWindowsMenuInputPlan {
        action: action.to_owned(),
        expected_thread_id,
        key_codes: desktop_e2e_windows_tab_menu_key_codes(action, target_rank)?,
        window_id: window_id.to_owned(),
    };
    let (setup_sender, setup_receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("rion-desktop-e2e-native-menu".to_owned())
        .spawn(move || {
            let hook = unsafe {
                SetWinEventHook(
                    EVENT_SYSTEM_MENUPOPUPSTART,
                    EVENT_SYSTEM_MENUPOPUPSTART,
                    None,
                    Some(desktop_e2e_windows_menu_popup_started),
                    std::process::id(),
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            if hook.0.is_null() {
                let _ = setup_sender.send(Err(
                    "The native menu popup event hook could not be installed.".to_owned(),
                ));
                return;
            }
            let plan_installed = DESKTOP_E2E_WINDOWS_MENU_INPUT_PLAN
                .get_or_init(|| std::sync::Mutex::new(None))
                .lock()
                .map_err(|_| "The native menu input plan is unavailable.".to_owned())
                .and_then(|mut pending| {
                    if pending.is_some() {
                        return Err("A native menu input plan is already armed.".to_owned());
                    }
                    *pending = Some(plan);
                    Ok(())
                });
            if let Err(error) = plan_installed {
                let _ = unsafe { UnhookWinEvent(hook) };
                let _ = setup_sender.send(Err(error));
                return;
            }
            let _ = setup_sender.send(Ok(()));
            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {}
            let _ = unsafe { UnhookWinEvent(hook) };
        })
        .map_err(|error| error.to_string())?;
    setup_receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The native menu popup event hook was not armed.".to_owned())?
}
