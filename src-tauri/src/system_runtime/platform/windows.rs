// Windows WebView2/Win32 adapter, statically selected at compile time.

use super::super::*;

#[cfg(windows)]
pub(in crate::system_runtime) fn platform_webview_diagnostics(
    webview: &Webview,
) -> PlatformWebViewDiagnostics {
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_KIND_BROWSER, COREWEBVIEW2_PROCESS_KIND_GPU,
            COREWEBVIEW2_PROCESS_KIND_RENDERER, ICoreWebView2, ICoreWebView2Environment,
            ICoreWebView2Environment8,
        },
        take_pwstr,
    };
    use windows::core::{HSTRING, Interface};

    let (process_sender, process_receiver) = std::sync::mpsc::sync_channel(1);
    let (gpu_sender, gpu_receiver) = std::sync::mpsc::sync_channel(1);
    if webview
        .with_webview(move |platform_webview| unsafe {
            let environment: ICoreWebView2Environment = platform_webview.environment();
            let mut process_diagnostics = PlatformWebViewDiagnostics::default();
            let mut raw_version = windows::core::PWSTR::null();
            if environment.BrowserVersionString(&mut raw_version).is_ok() && !raw_version.is_null()
            {
                process_diagnostics.runtime_version = Some(take_pwstr(raw_version));
            }
            if let Ok(environment8) = environment.cast::<ICoreWebView2Environment8>()
                && let Ok(processes) = environment8.GetProcessInfos()
            {
                let mut count = 0;
                if processes.Count(&mut count).is_ok() {
                    let mut browser_process_present = false;
                    let mut renderer_process_present = false;
                    let mut gpu_process_present = false;
                    for index in 0..count {
                        let Ok(process) = processes.GetValueAtIndex(index) else {
                            continue;
                        };
                        let mut kind = COREWEBVIEW2_PROCESS_KIND_RENDERER;
                        if process.Kind(&mut kind).is_err() {
                            continue;
                        }
                        browser_process_present |= kind == COREWEBVIEW2_PROCESS_KIND_BROWSER;
                        renderer_process_present |= kind == COREWEBVIEW2_PROCESS_KIND_RENDERER;
                        gpu_process_present |= kind == COREWEBVIEW2_PROCESS_KIND_GPU;
                    }
                    process_diagnostics.browser_process_present = Some(browser_process_present);
                    process_diagnostics.renderer_process_present = Some(renderer_process_present);
                    process_diagnostics.gpu_process_present = Some(gpu_process_present);
                }
            }
            let _ = process_sender.send(process_diagnostics);

            let completion_sender = gpu_sender.clone();
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
                        core.CallDevToolsProtocolMethod(
                            &HSTRING::from("SystemInfo.getInfo"),
                            &HSTRING::from("{}"),
                            &handler,
                        )
                    });
            if let Err(error) = result {
                let _ = gpu_sender.send(Err(error.to_string()));
            }
        })
        .is_err()
    {
        return PlatformWebViewDiagnostics::default();
    }
    let deadline = Instant::now() + PLATFORM_CALLBACK_TIMEOUT;
    let mut diagnostics = process_receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .unwrap_or_default();
    if let Ok(Ok(raw)) =
        gpu_receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        && let Some(gpu) = decode_webview2_gpu_diagnostics(&raw)
    {
        diagnostics.graphics_renderer = gpu.graphics_renderer;
        diagnostics.graphics_vendor = gpu.graphics_vendor;
        diagnostics.hardware_acceleration_enabled = gpu.hardware_acceleration_enabled;
    }
    diagnostics
}

#[cfg(any(windows, test))]
pub(in crate::system_runtime) fn decode_webview2_gpu_diagnostics(
    raw: &str,
) -> Option<PlatformWebViewDiagnostics> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    let gpu = value.get("gpu")?;
    let device = gpu.get("devices")?.as_array()?.first();
    let auxiliary = gpu.get("auxAttributes");
    let graphics_renderer = device
        .and_then(|device| device.get("deviceString"))
        .and_then(Value::as_str)
        .or_else(|| auxiliary?.get("glRenderer")?.as_str())
        .map(str::to_owned);
    let graphics_vendor = device
        .and_then(|device| device.get("vendorString"))
        .and_then(Value::as_str)
        .or_else(|| auxiliary?.get("glVendor")?.as_str())
        .map(str::to_owned);
    let feature_status = gpu.get("featureStatus")?.as_object();
    let hardware_acceleration_enabled = feature_status.and_then(|features| {
        let webgl = features.get("webgl")?.as_str()?.to_ascii_lowercase();
        Some(webgl.contains("enabled") && !webgl.contains("software"))
    });
    Some(PlatformWebViewDiagnostics {
        graphics_renderer,
        graphics_vendor,
        hardware_acceleration_enabled,
        ..PlatformWebViewDiagnostics::default()
    })
}

include!("windows/input_security.rs");
include!("windows/lifecycle.rs");
#[cfg(windows)]
include!("windows/live_resize.rs");
include!("windows/material.rs");
include!("windows/reparent.rs");

#[cfg(windows)]
pub(in crate::system_runtime) fn platform_page_zoom(webview: &Webview) -> RuntimeResult<f64> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let controller = platform_webview.controller();
            let mut zoom_factor = 0.0;
            let result = controller.ZoomFactor(&mut zoom_factor).map_err(|error| {
                RuntimeError::new(
                    "BROWSER_PAGE_ZOOM_UNAVAILABLE",
                    format!("WebView2 did not report its applied page zoom: {error}"),
                )
            });
            let _ = sender.send(result.map(|()| zoom_factor));
        })
        .map_err(RuntimeError::tauri)?;
    let zoom_factor = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|_| {
            RuntimeError::new(
                "BROWSER_PAGE_ZOOM_TIMEOUT",
                "WebView2 page zoom acknowledgement timed out.",
            )
        })??;
    validate_applied_page_zoom(zoom_factor)
}
