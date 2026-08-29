#[cfg(windows)]
#[derive(Clone, Debug, Default)]
struct DesktopE2eDocumentViewport {
    height: f64,
    resize_event_count: u64,
    width: f64,
}

#[cfg(windows)]
#[derive(Clone, Debug)]
struct DesktopE2eDocumentViewportChannel {
    generation: u64,
    viewport: Option<DesktopE2eDocumentViewport>,
}

#[cfg(windows)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopE2eDocumentViewportMessage {
    event: String,
    height: f64,
    kind: String,
    role_id: String,
    width: f64,
}

#[cfg(windows)]
static DESKTOP_E2E_WINDOWS_ROLE_VIEWPORTS:
    std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, DesktopE2eDocumentViewportChannel>>,
    > =
    std::sync::OnceLock::new();

#[cfg(windows)]
static DESKTOP_E2E_WINDOWS_ROLE_VIEWPORT_GENERATION: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
fn desktop_e2e_windows_role_viewports(
) -> &'static std::sync::Mutex<HashMap<String, DesktopE2eDocumentViewportChannel>> {
    DESKTOP_E2E_WINDOWS_ROLE_VIEWPORTS.get_or_init(Default::default)
}

#[cfg(windows)]
fn desktop_e2e_windows_role_viewport_probe_script(role_id: &str) -> String {
    let role_id = json!(role_id);
    format!(
        r#"(() => {{
  if (globalThis.top !== globalThis) return;
  const roleId = {role_id};
  const publish = (event) => globalThis.chrome?.webview?.postMessage(JSON.stringify({{
    event,
    height: innerHeight,
    kind: "rion-desktop-e2e-role-viewport-v1",
    roleId,
    width: innerWidth
  }}));
  addEventListener("resize", () => publish("resize"));
  queueMicrotask(() => publish("initial"));
}})();"#
    )
}

#[cfg(windows)]
fn desktop_e2e_windows_register_role_viewport_channel(
    surface_label: &str,
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) {
    use webview2_com::{
        CoTaskMemPWSTR, WebMessageReceivedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::PWSTR;

    let Ok(core): Result<ICoreWebView2, _> = (unsafe { controller.CoreWebView2() }) else {
        return;
    };
    let channel_generation = DESKTOP_E2E_WINDOWS_ROLE_VIEWPORT_GENERATION
        .fetch_add(1, Ordering::AcqRel)
        .saturating_add(1);
    let surface_label = surface_label.to_owned();
    // Role labels can be reused after ownership transfer. Replace their evidence channel so a
    // late message from the retired controller cannot satisfy the new surface's viewport fence.
    if let Ok(mut viewports) = desktop_e2e_windows_role_viewports().lock() {
        viewports.insert(
            surface_label.clone(),
            DesktopE2eDocumentViewportChannel {
                generation: channel_generation,
                viewport: None,
            },
        );
    }
    let handler = WebMessageReceivedEventHandler::create(Box::new(move |_webview, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut raw = PWSTR::null();
        if unsafe { args.TryGetWebMessageAsString(&mut raw) }.is_err() {
            return Ok(());
        }
        let message = CoTaskMemPWSTR::from(raw).to_string();
        let Ok(message) = serde_json::from_str::<DesktopE2eDocumentViewportMessage>(&message)
        else {
            return Ok(());
        };
        if message.kind != "rion-desktop-e2e-role-viewport-v1"
            || !matches!(message.event.as_str(), "initial" | "resize")
            || !message.width.is_finite()
            || !message.height.is_finite()
            || message.width <= 0.0
            || message.height <= 0.0
        {
            return Ok(());
        }
        let mut recorded = false;
        if let Ok(mut viewports) = desktop_e2e_windows_role_viewports().lock()
            && let Some(channel) = viewports.get_mut(&surface_label)
            && channel.generation == channel_generation
        {
            let viewport = channel.viewport.get_or_insert_default();
            viewport.height = message.height;
            viewport.width = message.width;
            if message.event == "resize" {
                viewport.resize_event_count = viewport.resize_event_count.saturating_add(1);
            }
            recorded = true;
        }
        if recorded {
            crate::desktop_e2e::record_event(
                &format!("windows-role-viewport-observed:{}", message.role_id),
                None,
                None,
                None,
                json!({
                    "channelGeneration": channel_generation,
                    "event": message.event,
                    "height": message.height,
                    "roleId": message.role_id,
                    "surfaceLabel": surface_label,
                    "width": message.width,
                }),
            );
        }
        Ok(())
    }));
    let mut token = 0;
    let _ = unsafe { core.add_WebMessageReceived(&handler, &mut token) };
}

#[cfg(windows)]
fn desktop_e2e_windows_role_surface_snapshot(
    role_id: &str,
    webview: &Webview,
    window: &Window,
    include_document_viewport: bool,
) -> Result<Value, String> {
    let (controller_bounds, host_bounds) = desktop_e2e_windows_webview_geometry(webview)?;
    let native = windows_observe_selected_surface(webview, window)?;
    let page_zoom_factor = platform_page_zoom(webview).map_err(|error| error.message)?;
    let document_viewport = include_document_viewport
        .then(|| desktop_e2e_windows_document_viewport(webview.label()))
        .flatten();
    let mut snapshot = json!({
        "controllerBounds": controller_bounds,
        "controllerVisible": native.controller_visible,
        "hostBounds": host_bounds,
        "pageZoomFactor": page_zoom_factor,
        "parentWindowMatchesHost": native.parent_window_matches_host,
        "roleId": role_id,
        "webviewLabel": webview.label(),
    });
    if let Some(viewport) = document_viewport {
        snapshot["documentViewport"] = json!({
            "height": viewport.height,
            "resizeEventCount": viewport.resize_event_count,
            "width": viewport.width,
        });
    }
    Ok(snapshot)
}

#[cfg(windows)]
fn desktop_e2e_windows_document_viewport(
    surface_label: &str,
) -> Option<DesktopE2eDocumentViewport> {
    desktop_e2e_windows_role_viewports()
        .lock()
        .ok()?
        .get(surface_label)?
        .viewport
        .clone()
}

#[cfg(windows)]
fn desktop_e2e_windows_webview_geometry(webview: &Webview) -> Result<(Value, Value), String> {
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Gdi::{ClientToScreen, ScreenToClient},
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{GetAncestor, GetClientRect, GA_ROOT},
        },
    };

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
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
                let root = GetAncestor(parent, GA_ROOT);
                if root.is_invalid() {
                    return Err("The WebView2 role-surface root window is unavailable.".to_owned());
                }
                let mut host_origin = POINT::default();
                ClientToScreen(parent, &mut host_origin)
                    .ok()
                    .map_err(|error| error.to_string())?;
                ScreenToClient(root, &mut host_origin)
                    .ok()
                    .map_err(|error| error.to_string())?;
                let scale = f64::from(GetDpiForWindow(root).max(96)) / 96.0;
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
                        "x": logical(host_origin.x),
                        "y": logical(host_origin.y),
                    }),
                ))
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| "The WebView2 role-surface bounds readback did not complete.".to_owned())?
}
