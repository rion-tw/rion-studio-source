// Windows WebView2/Win32 adapter, statically selected at compile time.

include!("windows/input_security.rs");
include!("windows/lifecycle.rs");
#[cfg(windows)]
include!("windows/live_resize.rs");
include!("windows/material.rs");
include!("windows/reparent.rs");

#[cfg(windows)]
fn platform_page_zoom(webview: &Webview) -> RuntimeResult<f64> {
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
    let zoom_factor = receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT).map_err(|_| {
        RuntimeError::new(
            "BROWSER_PAGE_ZOOM_TIMEOUT",
            "WebView2 page zoom acknowledgement timed out.",
        )
    })??;
    validate_applied_page_zoom(zoom_factor)
}
