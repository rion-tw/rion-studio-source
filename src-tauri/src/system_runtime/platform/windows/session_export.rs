#[cfg(windows)]
struct WindowsWebview2ExportIdentity {
    profile_path: PathBuf,
    runtime_version: String,
}

#[cfg(windows)]
pub(in crate::system_runtime) async fn capture_windows_webview2_role_session_source(
    webview: &Webview,
) -> RuntimeResult<Webview2RoleSessionSourceObservation> {
    // This is a fixed, privileged export path over the in-process WebView2 COM
    // object. It never enables a debugging endpoint, accepts an external
    // client, or exposes a general protocol dispatcher.
    let identity = observe_windows_webview2_export_identity(webview).await?;
    let browser_version =
        call_windows_webview2_export_protocol_method(webview, "Browser.getVersion").await?;
    // Protocol completions may arrive out of order, so the cookie call is
    // submitted only after the exact Browser.getVersion completion above.
    let cookies =
        call_windows_webview2_export_protocol_method(webview, "Storage.getCookies").await?;
    decode_webview2_export_observation(
        &identity.runtime_version,
        identity.profile_path,
        &browser_version,
        &cookies,
    )
}

#[cfg(windows)]
async fn observe_windows_webview2_export_identity(
    webview: &Webview,
) -> RuntimeResult<WindowsWebview2ExportIdentity> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2, ICoreWebView2_13, ICoreWebView2Environment,
        },
        take_pwstr,
    };
    use windows::core::Interface;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| -> RuntimeResult<WindowsWebview2ExportIdentity> {
                let environment: ICoreWebView2Environment = platform_webview.environment();
                let mut runtime_version = windows::core::PWSTR::null();
                environment
                    .BrowserVersionString(&mut runtime_version)
                    .map_err(|_| windows_webview2_export_native_error())?;
                if runtime_version.is_null() {
                    return Err(windows_webview2_export_native_error());
                }
                let runtime_version = take_pwstr(runtime_version);
                let core: ICoreWebView2 = platform_webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|_| windows_webview2_export_native_error())?;
                let mut source = windows::core::PWSTR::null();
                core.Source(&mut source)
                    .map_err(|_| windows_webview2_export_native_error())?;
                if source.is_null() || take_pwstr(source) != "about:blank" {
                    return Err(webview2_export_error(
                        "ROLE_SESSION_TRANSFER_WEBVIEW2_KEEPER_NAVIGATED",
                        "The privileged WebView2 export keeper left its opaque blank document.",
                    ));
                }
                let profile = core
                    .cast::<ICoreWebView2_13>()
                    .and_then(|core| core.Profile())
                    .map_err(|_| windows_webview2_export_native_error())?;
                let mut profile_name = windows::core::PWSTR::null();
                let mut profile_path = windows::core::PWSTR::null();
                let mut in_private = windows::core::BOOL::default();
                profile
                    .ProfileName(&mut profile_name)
                    .and_then(|()| profile.ProfilePath(&mut profile_path))
                    .and_then(|()| profile.IsInPrivateModeEnabled(&mut in_private))
                    .map_err(|_| windows_webview2_export_native_error())?;
                if profile_name.is_null()
                    || profile_path.is_null()
                    || take_pwstr(profile_name) != "Default"
                    || in_private.as_bool()
                {
                    return Err(windows_webview2_export_native_error());
                }
                Ok(WindowsWebview2ExportIdentity {
                    profile_path: PathBuf::from(take_pwstr(profile_path)),
                    runtime_version,
                })
            })();
            let _ = sender.send(result);
        })
        .map_err(|_| windows_webview2_export_native_error())?;
    receiver.await.map_err(|_| {
        webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_NATIVE_EVENT_CANCELLED",
            "The exact WebView2 native identity event stream stopped.",
        )
    })?
}

#[cfg(windows)]
async fn call_windows_webview2_export_protocol_method(
    webview: &Webview,
    method: &'static str,
) -> RuntimeResult<String> {
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::HSTRING;

    if !matches!(method, "Browser.getVersion" | "Storage.getCookies") {
        return Err(windows_webview2_export_native_error());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = Arc::clone(&sender);
    webview
        .with_webview(move |platform_webview| unsafe {
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, value| {
                    let result = status
                        .map(|()| value)
                        .map_err(|_| windows_webview2_export_native_error());
                    if let Ok(mut sender) = callback_sender.lock()
                        && let Some(sender) = sender.take()
                    {
                        let _ = sender.send(result);
                    }
                    Ok(())
                },
            ));
            let result =
                platform_webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core: ICoreWebView2| {
                        core.CallDevToolsProtocolMethod(
                            &HSTRING::from(method),
                            &HSTRING::from("{}"),
                            &handler,
                        )
                    });
            if result.is_err()
                && let Ok(mut sender) = sender.lock()
                && let Some(sender) = sender.take()
            {
                let _ = sender.send(Err(windows_webview2_export_native_error()));
            }
        })
        .map_err(|_| windows_webview2_export_native_error())?;
    receiver.await.map_err(|_| {
        webview2_export_error(
            "ROLE_SESSION_TRANSFER_WEBVIEW2_NATIVE_EVENT_CANCELLED",
            "The exact WebView2 protocol completion stream stopped.",
        )
    })?
}

#[cfg(windows)]
fn windows_webview2_export_native_error() -> RuntimeError {
    webview2_export_error(
        "ROLE_SESSION_TRANSFER_WEBVIEW2_NATIVE_OBSERVATION_FAILED",
        "WebView2 could not provide a complete privileged export observation.",
    )
}
