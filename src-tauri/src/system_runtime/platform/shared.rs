// shared system-runtime adapter; definitions keep explicit compile-time cfg boundaries.

fn compensated_key_effect(effect: &EmbeddedKeyEffectRecord) -> EmbeddedKeyEffectRecord {
    EmbeddedKeyEffectRecord {
        phase: if effect.phase == "rawKeyDown" {
            "keyUp".to_owned()
        } else {
            "rawKeyDown".to_owned()
        },
        code: effect.code.clone(),
        active_codes_before: effect.active_codes.clone(),
        active_codes: effect.active_codes_before.clone(),
        auto_repeat: false,
        suppress_shortcut: effect.suppress_shortcut,
    }
}

fn parse_devtools_viewport(source: &str) -> Option<ViewportSize> {
    let value = serde_json::from_str::<Value>(source).ok()?;
    for key in ["cssVisualViewport", "layoutViewport"] {
        if let Some(viewport) = value.get(key)
            && let Some(size) = viewport_size_from_value(viewport)
        {
            return Some(size);
        }
    }
    None
}

fn parse_evaluated_viewport(source: &str) -> Option<ViewportSize> {
    let value = serde_json::from_str::<Value>(source).ok()?;
    if let Some(size) = viewport_size_from_value(&value) {
        return Some(size);
    }
    value
        .as_str()
        .and_then(|nested| serde_json::from_str::<Value>(nested).ok())
        .and_then(|nested| viewport_size_from_value(&nested))
}

fn viewport_size_from_value(value: &Value) -> Option<ViewportSize> {
    let width = value
        .get("clientWidth")
        .or_else(|| value.get("width"))?
        .as_f64()?;
    let height = value
        .get("clientHeight")
        .or_else(|| value.get("height"))?
        .as_f64()?;
    (width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0)
        .then_some(ViewportSize { width, height })
}

fn resolve_click_point(
    anchor: Option<&str>,
    unit: &str,
    x: f64,
    y: f64,
    viewport: ViewportSize,
) -> RuntimeResult<ClickPoint> {
    if !x.is_finite() || !y.is_finite() {
        return Err(RuntimeError::new(
            "BROWSER_CLICK_INVALID",
            "Click coordinates must be finite.",
        ));
    }
    let (anchor_x, anchor_y) = match anchor.unwrap_or("top-left") {
        "top-left" => (0.0, 0.0),
        "top-center" => (50.0, 0.0),
        "top-right" => (100.0, 0.0),
        "center-left" => (0.0, 50.0),
        "center" => (50.0, 50.0),
        "center-right" => (100.0, 50.0),
        "bottom-left" => (0.0, 100.0),
        "bottom-center" => (50.0, 100.0),
        "bottom-right" => (100.0, 100.0),
        _ => {
            return Err(RuntimeError::new(
                "BROWSER_CLICK_INVALID",
                "Click anchor is invalid.",
            ));
        }
    };
    let (raw_x, raw_y) = match unit {
        "percent" => (
            viewport.width * (anchor_x + x) / 100.0,
            viewport.height * (anchor_y + y) / 100.0,
        ),
        "px" => (
            viewport.width * anchor_x / 100.0 + x,
            viewport.height * anchor_y / 100.0 + y,
        ),
        _ => {
            return Err(RuntimeError::new(
                "BROWSER_CLICK_INVALID",
                "Click coordinate unit is invalid.",
            ));
        }
    };
    Ok(ClickPoint {
        x: raw_x.round().clamp(0.0, (viewport.width - 1.0).max(0.0)) as i64,
        y: raw_y.round().clamp(0.0, (viewport.height - 1.0).max(0.0)) as i64,
    })
}

fn validate_mouse_button(button: &str) -> RuntimeResult<&str> {
    if matches!(button, "left" | "middle" | "right") {
        Ok(button)
    } else {
        Err(RuntimeError::new(
            "BROWSER_CLICK_INVALID",
            "Mouse button is invalid.",
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn prepare_platform_role_webview_builder(
    _app: &AppHandle,
    builder: WebviewBuilder<tauri::Wry>,
    _data_store_identifier: [u8; 16],
    _enabled: bool,
) -> (WebviewBuilder<tauri::Wry>, HighRefreshRateDiagnosticStatus) {
    (builder, HighRefreshRateDiagnosticStatus::NotApplicable)
}

#[cfg(any(target_os = "macos", test))]
fn high_refresh_rate_status_label(status: HighRefreshRateDiagnosticStatus) -> &'static str {
    match status {
        HighRefreshRateDiagnosticStatus::Applied => "applied",
        HighRefreshRateDiagnosticStatus::Disabled => "disabled",
        HighRefreshRateDiagnosticStatus::Unavailable => "unavailable",
        HighRefreshRateDiagnosticStatus::Failed => "failed",
        HighRefreshRateDiagnosticStatus::Timeout => "timeout",
        HighRefreshRateDiagnosticStatus::ScheduleFailed => "schedule-failed",
        HighRefreshRateDiagnosticStatus::NotApplicable => "not-applicable",
    }
}

#[cfg(not(windows))]
fn install_document_navigation_macro_release_handler(
    _webview: &Webview,
    _app: AppHandle,
    _role_id: &str,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(any(windows, test))]
fn windows_shortcut_modifier_codes(
    left_control: bool,
    right_control: bool,
    shift: bool,
    left_shift: bool,
    right_shift: bool,
) -> Vec<String> {
    let mut codes = Vec::new();
    if left_control {
        codes.push("ControlLeft".to_owned());
    }
    if right_control {
        codes.push("ControlRight".to_owned());
    }
    if !left_control && !right_control {
        codes.push("ControlLeft".to_owned());
    }
    if shift {
        if left_shift {
            codes.push("ShiftLeft".to_owned());
        }
        if right_shift {
            codes.push("ShiftRight".to_owned());
        }
        if !left_shift && !right_shift {
            codes.push("ShiftLeft".to_owned());
        }
    }
    codes
}

#[cfg(any(windows, test))]
fn shortcut_modifier_release_effects(modifier_codes: &[String]) -> Vec<EmbeddedKeyEffectRecord> {
    let mut active_codes = modifier_codes.to_vec();
    modifier_codes
        .iter()
        .rev()
        .map(|code| {
            let before = active_codes.clone();
            active_codes.retain(|active| active != code);
            EmbeddedKeyEffectRecord {
                phase: "keyUp".to_owned(),
                code: code.clone(),
                active_codes_before: before,
                active_codes: active_codes.clone(),
                auto_repeat: false,
                suppress_shortcut: false,
            }
        })
        .collect()
}

fn is_tab_shortcut_modifier_code(code: &str) -> bool {
    matches!(
        code,
        "ControlLeft" | "ControlRight" | "ShiftLeft" | "ShiftRight"
    )
}

#[cfg(any(windows, test))]
fn windows_role_zoom_action(
    virtual_key: u32,
    control: bool,
    alt: bool,
    meta: bool,
    shift: bool,
) -> Option<&'static str> {
    if !control || alt || meta {
        return None;
    }
    match virtual_key {
        0x30 | 0x60 if !shift => Some("reset"),
        0xBD | 0x6D if !shift => Some("out"),
        0xBB => Some("in"),
        0x6B if !shift => Some("in"),
        _ => None,
    }
}

#[cfg(any(windows, test))]
fn windows_application_shortcut_command(
    virtual_key: u32,
    control: bool,
    alt: bool,
    meta: bool,
    shift: bool,
    repeat: bool,
) -> Option<crate::application_menu::ApplicationShortcutCommand> {
    use crate::application_menu::ApplicationShortcutCommand;

    if virtual_key == 0x7A {
        return (!control && !alt && !meta && !shift && !repeat)
            .then_some(ApplicationShortcutCommand::ToggleFullscreen);
    }
    if virtual_key == 0x4E {
        return (control && !alt && !meta && !shift && !repeat)
            .then_some(ApplicationShortcutCommand::NewGameWindow);
    }
    windows_role_zoom_action(virtual_key, control, alt, meta, shift).map(|action| match action {
        "in" => ApplicationShortcutCommand::ZoomIn,
        "out" => ApplicationShortcutCommand::ZoomOut,
        _ => ApplicationShortcutCommand::ZoomReset,
    })
}

#[cfg(test)]
fn macos_role_zoom_action(
    key_code: u16,
    command: bool,
    control: bool,
    option: bool,
    shift: bool,
) -> Option<&'static str> {
    if !command || control || option {
        return None;
    }
    match key_code {
        29 | 82 if !shift => Some("reset"),
        27 | 78 if !shift => Some("out"),
        24 => Some("in"),
        69 if !shift => Some("in"),
        _ => None,
    }
}

#[cfg(not(windows))]
fn platform_role_surface_setup(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
) -> Result<Arc<SurfaceLifecycleTracker>, RoleSurfaceSetupFailure> {
    platform_role_surface_setup_inner(webview, app, target).map_err(|error| {
        RoleSurfaceSetupFailure {
            error,
            lifecycle: None,
        }
    })
}

#[cfg(not(windows))]
fn install_process_failure_monitor(
    _webview: &Webview,
    _app: AppHandle,
    _target: SurfaceFailureTarget,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(windows))]
fn call_system_devtools(
    _webview: &Webview,
    _method: &str,
    _params: &Value,
) -> RuntimeResult<String> {
    Err(RuntimeError::new(
        "BROWSER_DEBUGGER_UNAVAILABLE",
        "WKWebView does not expose a public per-session DevTools protocol.",
    ))
}

type RuntimeResult<T> = Result<T, RuntimeError>;

#[derive(Debug)]
pub(crate) struct RuntimeError {
    pub(crate) code: &'static str,
    diagnostic: Option<RuntimeErrorDiagnostic>,
    pub(crate) message: String,
}
