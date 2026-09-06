// Windows WebView2/Win32 adapter, statically selected at compile time.

use super::super::*;

#[cfg(windows)]
pub(in crate::system_runtime) fn clear_platform_browser_data_event_bound(
    webview: &Webview,
) -> RuntimeResult<()> {
    use webview2_com::{
        ClearBrowsingDataCompletedHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2_13, ICoreWebView2Profile2},
    };
    use windows::core::Interface;

    await_event_bound_native_terminal(|terminal_sender| {
        webview
            .with_webview(move |platform_webview| unsafe {
                let completion_sender = terminal_sender.clone();
                let completion =
                    ClearBrowsingDataCompletedHandler::create(Box::new(move |status| {
                        let result = if status.is_ok() {
                            Ok(())
                        } else {
                            Err(RuntimeError::new(
                                "SYSTEM_BROWSER_DATA_CLEAR_NATIVE_FAILED",
                                "WebView2 reported that browser-data clearing did not complete.",
                            ))
                        };
                        let _ = completion_sender.send(result);
                        Ok(())
                    }));
                let submitted = platform_webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|webview| webview.cast::<ICoreWebView2_13>())
                    .and_then(|webview| webview.Profile())
                    .and_then(|profile| profile.cast::<ICoreWebView2Profile2>())
                    .and_then(|profile| profile.ClearBrowsingDataAll(&completion));
                if submitted.is_err() {
                    let _ = terminal_sender.send(Err(RuntimeError::new(
                        "SYSTEM_BROWSER_DATA_CLEAR_SUBMISSION_FAILED",
                        "WebView2 rejected the browser-data clear request before submission.",
                    )));
                }
            })
            .map_err(RuntimeError::tauri)
    })
}

include!("windows/input_security.rs");
include!("windows/lifecycle.rs");
#[cfg(windows)]
include!("windows/live_resize.rs");
include!("windows/material.rs");
include!("windows/reparent.rs");
#[cfg(windows)]
include!("windows/selected_surface_reprojection.rs");
#[cfg(windows)]
include!("windows/session_export.rs");

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

#[cfg(windows)]
pub(in crate::system_runtime) fn platform_workspace_web_history_state(
    webview: &Webview,
) -> RuntimeResult<(bool, bool)> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| {
                    let mut can_go_back = windows::core::BOOL::default();
                    let mut can_go_forward = windows::core::BOOL::default();
                    core.CanGoBack(&mut can_go_back)?;
                    core.CanGoForward(&mut can_go_forward)?;
                    Ok((can_go_back.as_bool(), can_go_forward.as_bool()))
                })
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(Ok(state)) => Ok(state),
        Ok(Err(error)) => Err(RuntimeError::new(
            "WORKSPACE_WEB_HISTORY_UNAVAILABLE",
            error,
        )),
        Err(_) => Err(RuntimeError::new(
            "WORKSPACE_WEB_HISTORY_TIMEOUT",
            "WebView2 navigation history acknowledgement timed out.",
        )),
    }
}

#[cfg(windows)]
pub(in crate::system_runtime) fn request_platform_workspace_web_navigation(
    webview: &Webview,
    action: WorkspaceWebNativeNavigationAction,
) -> RuntimeResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = platform_webview
                .controller()
                .CoreWebView2()
                .and_then(|core: ICoreWebView2| match action {
                    WorkspaceWebNativeNavigationAction::Back => core.GoBack(),
                    WorkspaceWebNativeNavigationAction::Forward => core.GoForward(),
                    WorkspaceWebNativeNavigationAction::Reload => core.Reload(),
                })
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    match receiver.recv_timeout(PLATFORM_CALLBACK_TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(RuntimeError::new("WORKSPACE_WEB_NAVIGATION_FAILED", error)),
        Err(_) => Err(RuntimeError::new(
            "WORKSPACE_WEB_NAVIGATION_TIMEOUT",
            "WebView2 navigation acknowledgement timed out.",
        )),
    }
}
