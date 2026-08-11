fn verify_local_storage_snapshot(
    webview: &Webview,
    expected: &[(String, String)],
) -> RuntimeResult<()> {
    let state = evaluate_json_value(webview, "globalThis.__rionSessionRestoreState ?? null")?;
    let mut values = storage_entries_from_value(&state, "values")?;
    let mut expected = expected.to_vec();
    values.sort();
    expected.sort();
    if values == expected
        && state.get("size").and_then(Value::as_u64) == Some(expected.len() as u64)
    {
        Ok(())
    } else {
        Err(RuntimeError::new(
            "SESSION_IMPORT_ROLLBACK_VERIFY_FAILED",
            "System WebView LocalStorage rollback did not match its backup.",
        ))
    }
}

fn macro_overlay_document_start_script_template() -> Result<String, String> {
    let guard_token = serde_json::to_string(MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN)
        .map_err(|error| error.to_string())?;
    let trusted_event_guard_token = serde_json::to_string(MACRO_OVERLAY_TRUSTED_EVENT_GUARD_TOKEN)
        .map_err(|error| error.to_string())?;
    let binding_token =
        serde_json::to_string(MACRO_OVERLAY_BINDING_TOKEN).map_err(|error| error.to_string())?;
    let css_token =
        serde_json::to_string(MACRO_OVERLAY_CSS_TOKEN).map_err(|error| error.to_string())?;
    let coordinate_measurement_module_token =
        serde_json::to_string(MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE_TOKEN)
            .map_err(|error| error.to_string())?;
    let coordinate_measurement_module_importer_token =
        serde_json::to_string(MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER_TOKEN)
            .map_err(|error| error.to_string())?;
    let with_guard = replace_single_script_token(
        MACRO_OVERLAY_RUNTIME_SOURCE,
        &guard_token,
        MACRO_OVERLAY_SHORTCUT_GUARD_SOURCE.trim(),
    )?;
    let with_trusted_event_guard = replace_single_script_token(
        &with_guard,
        &trusted_event_guard_token,
        MACRO_OVERLAY_TRUSTED_EVENT_GUARD_SOURCE,
    )?;
    let css = serde_json::to_string(&format!("{DESIGN_TOKENS_CSS}\n{MACRO_OVERLAY_CSS}"))
        .map_err(|error| error.to_string())?;
    let with_css = replace_single_script_token(&with_trusted_event_guard, &css_token, &css)?;
    let coordinate_measurement_module =
        serde_json::to_string(MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE)
            .map_err(|error| error.to_string())?;
    let with_coordinate_measurement_module = replace_single_script_token(
        &with_css,
        &coordinate_measurement_module_token,
        &coordinate_measurement_module,
    )?;
    let runtime = replace_single_script_token(
        &with_coordinate_measurement_module,
        &coordinate_measurement_module_importer_token,
        MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER_SOURCE,
    )?;
    replace_single_script_token(
        &runtime,
        &binding_token,
        TAURI_MACRO_OVERLAY_BRIDGE_SOURCE.trim(),
    )
}

fn macro_overlay_document_start_script(template: &str, capability: &str) -> Result<String, String> {
    let capability_token =
        serde_json::to_string(MACRO_OVERLAY_CAPABILITY_TOKEN).map_err(|error| error.to_string())?;
    let capability = serde_json::to_string(capability).map_err(|error| error.to_string())?;
    replace_single_script_token(template, &capability_token, &capability)
}

fn runtime_indicator_document_start_script() -> Result<String, String> {
    let css_token =
        serde_json::to_string(RUNTIME_INDICATOR_CSS_TOKEN).map_err(|error| error.to_string())?;
    let css = serde_json::to_string(&format!("{DESIGN_TOKENS_CSS}\n{RUNTIME_INDICATOR_CSS}"))
        .map_err(|error| error.to_string())?;
    replace_single_script_token(RUNTIME_INDICATOR_RUNTIME_SOURCE, &css_token, &css)
}

fn should_refresh_macro_overlay(role_ids: &[String], role_id: &str) -> bool {
    role_ids.is_empty() || role_ids.iter().any(|candidate| candidate == role_id)
}

fn prepare_restore_session_for_persist(
    session: &mut RuntimeRestoreSessionRecord,
    clean_exit: bool,
    mut live_window_ids: Vec<String>,
) {
    session.schema_version = 2;
    session.updated_at = chrono::Utc::now().to_rfc3339();
    session.clean_exit = clean_exit;
    if clean_exit {
        session.restore_in_progress_window_ids.clear();
        if live_window_ids.is_empty() {
            live_window_ids = session.live_window_ids.clone().unwrap_or_default();
        }
    }
    live_window_ids.sort();
    live_window_ids.dedup();
    session.live_window_ids = Some(live_window_ids);
    session.windows.clear();
}

fn refresh_macro_overlay_handles<T, E>(
    handles: impl IntoIterator<Item = T>,
    mut refresh: impl FnMut(T) -> Result<(), E>,
) {
    for handle in handles {
        let _ = refresh(handle);
    }
}

fn should_release_macros_for_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn replace_single_script_token(
    source: &str,
    token: &str,
    replacement: &str,
) -> Result<String, String> {
    let mut matches = source.match_indices(token);
    let Some((index, _)) = matches.next() else {
        return Err(format!("Document-start script token is missing: {token}"));
    };
    if matches.next().is_some() {
        return Err(format!(
            "Document-start script token occurs more than once: {token}"
        ));
    }
    Ok(format!(
        "{}{}{}",
        &source[..index],
        replacement,
        &source[index + token.len()..]
    ))
}

fn native_font_document_start_script() -> String {
    BROWSER_FONTS_RUNTIME_SOURCE.to_owned()
}

#[derive(Clone, Copy)]
struct RoleBounds {
    height: f64,
    width: f64,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct WindowContentMetrics {
    height: f64,
    top_inset: f64,
    width: f64,
}

type ResolvedRuntimeLayout = (
    HashMap<String, RoleBounds>,
    Vec<(u32, WorkspaceDividerDescriptor, RoleBounds)>,
);

#[cfg(test)]
fn query_unlocked_snapshot<State, Snapshot, Output>(
    mutex: &Mutex<State>,
    snapshot: impl FnOnce(&State) -> Option<Snapshot>,
    query: impl FnOnce(Snapshot) -> Output,
) -> Option<Output> {
    let snapshot = {
        let state = mutex.lock().ok()?;
        snapshot(&state)?
    };
    Some(query(snapshot))
}

fn runtime_host_should_be_visible(
    reveal: bool,
    retain_visibility: bool,
    currently_visible: bool,
) -> bool {
    reveal || (currently_visible && retain_visibility)
}

fn runtime_host_should_receive_window_focus(focus_requested: bool, has_active_tab: bool) -> bool {
    focus_requested && !has_active_tab
}

fn failed_launch_cleanup_has_completed(
    state: &RuntimeState,
    tab_id: &str,
    attempt_generation: Option<&str>,
) -> bool {
    attempt_generation.is_some_and(|generation| {
        state
            .completed_failed_launch_cleanups
            .contains(&(tab_id.to_owned(), generation.to_owned()))
    })
}

fn launch_attempt_is_current(
    state: &RuntimeState,
    tab_id: &str,
    attempt_generation: Option<&str>,
) -> bool {
    attempt_generation.is_none_or(|generation| {
        state
            .launch_attempt_generations
            .get(tab_id)
            .is_some_and(|current| current == generation)
    })
}

fn log_error_details(code: &str, message: &str) -> LogErrorDetails {
    LogErrorDetails {
        name: code.to_owned(),
        message: message.to_owned(),
        stack: None,
        cause: None,
    }
}

fn runtime_target_requires_placement_reapply(presentation: &str, fullscreen: bool) -> bool {
    presentation != "fullscreen" || !fullscreen
}

fn logical_window_position(physical_x: i32, physical_y: i32, scale: f64) -> (i32, i32) {
    let scale = normalized_scale_factor(scale);
    (
        (physical_x as f64 / scale).round() as i32,
        (physical_y as f64 / scale).round() as i32,
    )
}

fn physical_window_position(logical_x: i32, logical_y: i32, scale: f64) -> (i32, i32) {
    let scale = normalized_scale_factor(scale);
    (
        (logical_x as f64 * scale).round() as i32,
        (logical_y as f64 * scale).round() as i32,
    )
}

fn normalized_scale_factor(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

#[cfg(any(not(windows), test))]
fn runtime_window_resize_is_actionable(width: u32, height: u32, minimized: bool) -> bool {
    width > 0 && height > 0 && !minimized
}

fn role_bounds_for_size(
    width: f64,
    height: f64,
    rect: &rion_core::StateNormalizedRectRecord,
) -> RoleBounds {
    RoleBounds {
        x: (rect.x * width).round().max(0.0),
        y: (rect.y * height).round().max(0.0),
        width: (rect.width * width).round().max(1.0),
        height: (rect.height * height).round().max(1.0),
    }
}

fn role_bounds_for_content(
    metrics: WindowContentMetrics,
    rect: &rion_core::StateNormalizedRectRecord,
) -> RoleBounds {
    let mut bounds = role_bounds_for_size(metrics.width, metrics.height, rect);
    bounds.y += metrics.top_inset;
    bounds
}

fn divider_hit_bounds(axis: &str, mut bounds: RoleBounds) -> RoleBounds {
    if axis == "vertical" && bounds.width < DIVIDER_HIT_TARGET {
        bounds.x -= (DIVIDER_HIT_TARGET - bounds.width) / 2.0;
        bounds.width = DIVIDER_HIT_TARGET;
    } else if axis == "horizontal" && bounds.height < DIVIDER_HIT_TARGET {
        bounds.y -= (DIVIDER_HIT_TARGET - bounds.height) / 2.0;
        bounds.height = DIVIDER_HIT_TARGET;
    }
    bounds
}

fn format_ratio(value: f64) -> String {
    let percent = (value * 1_000.0).round() / 10.0;
    if percent.fract().abs() < f64::EPSILON {
        format!("{percent:.0}%")
    } else {
        format!("{percent:.1}%")
    }
}

#[cfg(windows)]
fn runtime_window_content_metrics(window: &Window) -> RuntimeResult<WindowContentMetrics> {
    runtime_window_content_metrics_with_tab_strip(window, WINDOWS_TAB_STRIP_HEIGHT)
}

#[cfg(windows)]
fn runtime_window_content_metrics_with_tab_strip(
    window: &Window,
    tab_strip_height: f64,
) -> RuntimeResult<WindowContentMetrics> {
    let mut metrics = logical_window_content_metrics(window)?;
    metrics.top_inset += tab_strip_height;
    metrics.height = (metrics.height - tab_strip_height).max(1.0);
    Ok(metrics)
}

#[cfg(not(windows))]
fn runtime_window_content_metrics(window: &Window) -> RuntimeResult<WindowContentMetrics> {
    logical_window_content_metrics(window)
}

fn logical_window_content_metrics(window: &Window) -> RuntimeResult<WindowContentMetrics> {
    #[cfg(target_os = "macos")]
    {
        let window = window.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        window
            .clone()
            .run_on_main_thread(move || {
                let result = macos_window_content_metrics_now(&window);
                let _ = sender.send(result);
            })
            .map_err(RuntimeError::tauri)?;
        receiver
            .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
            .map_err(|_| {
                RuntimeError::new(
                    "TAURI_WINDOW_CONTENT_SIZE_TIMEOUT",
                    "The macOS content layout size query timed out.",
                )
            })?
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_WINDOW_CONTENT_SIZE_FAILED",
                    "The macOS content layout size was unavailable.",
                )
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let physical = window.inner_size().map_err(RuntimeError::tauri)?;
        let scale_factor = window
            .scale_factor()
            .map_err(RuntimeError::tauri)?
            .max(f64::EPSILON);
        Ok(WindowContentMetrics {
            height: (physical.height as f64 / scale_factor).max(1.0),
            top_inset: 0.0,
            width: (physical.width as f64 / scale_factor).max(1.0),
        })
    }
}

#[cfg(not(windows))]
fn snapshot_window_content_metrics(
    window: &Window,
    physical_width: u32,
    physical_height: u32,
    scale_factor: f64,
) -> Option<WindowContentMetrics> {
    #[cfg(target_os = "macos")]
    {
        let _ = (physical_width, physical_height, scale_factor);
        macos_window_content_metrics_now(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Some(logical_resize_metrics(
            physical_width,
            physical_height,
            scale_factor,
        ))
    }
}

#[cfg(any(not(target_os = "macos"), test))]
#[cfg(any(not(windows), test))]
fn logical_resize_metrics(
    physical_width: u32,
    physical_height: u32,
    scale_factor: f64,
) -> WindowContentMetrics {
    let scale_factor = normalized_scale_factor(scale_factor);
    WindowContentMetrics {
        height: (physical_height as f64 / scale_factor).max(1.0),
        top_inset: 0.0,
        width: (physical_width as f64 / scale_factor).max(1.0),
    }
}

#[cfg(target_os = "macos")]
fn macos_window_content_metrics_now(window: &Window) -> Option<WindowContentMetrics> {
    unsafe extern "C" {
        fn rion_wk_window_content_layout_metrics(
            window: *mut std::ffi::c_void,
            width: *mut f64,
            height: *mut f64,
            top_inset: *mut f64,
        ) -> bool;
    }
    window.ns_window().ok().and_then(|native| {
        let mut width = 0.0;
        let mut height = 0.0;
        let mut top_inset = 0.0;
        unsafe {
            rion_wk_window_content_layout_metrics(
                native,
                &mut width,
                &mut height,
                &mut top_inset,
            )
        }
        .then_some(WindowContentMetrics {
            height,
            top_inset,
            width,
        })
    })
}

fn runtime_label(prefix: &str, id: &str) -> String {
    let digest = Sha256::digest(id.as_bytes());
    let encoded = format!("{digest:x}");
    format!("{prefix}-{}", &encoded[..24])
}

fn is_current_system_engine(engine: ResolvedBrowserEngine) -> bool {
    if cfg!(target_os = "macos") {
        engine == ResolvedBrowserEngine::Wkwebview
    } else {
        engine == ResolvedBrowserEngine::Webview2
    }
}

fn supported_if(available: bool) -> EngineCapabilityStatus {
    if available {
        EngineCapabilityStatus::Supported
    } else {
        EngineCapabilityStatus::Disabled
    }
}

fn degraded_if(available: bool) -> EngineCapabilityStatus {
    if available {
        EngineCapabilityStatus::Degraded
    } else {
        EngineCapabilityStatus::Disabled
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ViewportSize {
    height: f64,
    width: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ClickPoint {
    x: i64,
    y: i64,
}

struct ClickActionDispatch<'a> {
    anchor: Option<&'a str>,
    unit: &'a str,
    x: f64,
    y: f64,
    button: &'a str,
}

fn resolve_modifier_codes(modifiers: &[String], macos: bool) -> RuntimeResult<Vec<String>> {
    let mut result = Vec::new();
    for modifier in modifiers {
        let code = match modifier.as_str() {
            "primary" if macos => "MetaLeft",
            "primary" | "ctrl" => "ControlLeft",
            "alt" => "AltLeft",
            "shift" => "ShiftLeft",
            "meta" => "MetaLeft",
            _ => {
                return Err(RuntimeError::new(
                    "BROWSER_KEY_MODIFIER_INVALID",
                    format!("Unsupported key modifier: {modifier}"),
                ));
            }
        };
        if !result.iter().any(|current| current == code) {
            result.push(code.to_owned());
        }
    }
    Ok(result)
}

#[cfg(any(windows, test))]
fn cdp_modifier_mask(active_codes: &[String]) -> u8 {
    active_codes.iter().fold(0, |mask, code| {
        mask | match code.as_str() {
            "AltLeft" | "AltRight" => 1,
            "ControlLeft" | "ControlRight" => 2,
            "MetaLeft" | "MetaRight" => 4,
            "ShiftLeft" | "ShiftRight" => 8,
            _ => 0,
        }
    })
}

#[cfg(any(windows, test))]
fn cdp_key_descriptor(code: &str, modifiers: u8) -> Value {
    let shift = modifiers & 8 != 0;
    let key = if code.len() == 4 && code.starts_with("Key") {
        let value = &code[3..];
        if shift {
            value.to_owned()
        } else {
            value.to_ascii_lowercase()
        }
    } else if code.len() == 6 && code.starts_with("Digit") {
        if shift {
            shifted_digit_key(code).unwrap_or(&code[5..]).to_owned()
        } else {
            code[5..].to_owned()
        }
    } else if shift {
        shifted_named_key(code)
            .or_else(|| named_key(code))
            .unwrap_or(code)
            .to_owned()
    } else {
        named_key(code).unwrap_or(code).to_owned()
    };
    let mut descriptor = serde_json::Map::new();
    descriptor.insert("code".to_owned(), json!(code));
    descriptor.insert("key".to_owned(), json!(key));
    if let Some(virtual_key_code) = windows_virtual_key_code(code, &key) {
        descriptor.insert("windowsVirtualKeyCode".to_owned(), json!(virtual_key_code));
    }
    if let Some(location) = key_location(code) {
        descriptor.insert("location".to_owned(), json!(location));
    }
    Value::Object(descriptor)
}

#[cfg(any(windows, test))]
fn named_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "AltLeft" | "AltRight" => "Alt",
        "ControlLeft" | "ControlRight" => "Control",
        "MetaLeft" | "MetaRight" => "Meta",
        "ShiftLeft" | "ShiftRight" => "Shift",
        "ArrowDown" => "ArrowDown",
        "ArrowLeft" => "ArrowLeft",
        "ArrowRight" => "ArrowRight",
        "ArrowUp" => "ArrowUp",
        "Backquote" => "`",
        "Backslash" => "\\",
        "Backspace" => "Backspace",
        "BracketLeft" => "[",
        "BracketRight" => "]",
        "Comma" => ",",
        "Enter" => "Enter",
        "Equal" => "=",
        "Escape" => "Escape",
        "Minus" => "-",
        "Period" => ".",
        "Quote" => "'",
        "Semicolon" => ";",
        "Slash" => "/",
        "Space" => " ",
        "Tab" => "Tab",
        "NumpadAdd" => "+",
        "NumpadDecimal" => ".",
        "NumpadDivide" => "/",
        "NumpadMultiply" => "*",
        "NumpadSubtract" => "-",
        _ => return None,
    })
}

#[cfg(any(windows, test))]
fn shifted_digit_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "Digit0" => ")",
        "Digit1" => "!",
        "Digit2" => "@",
        "Digit3" => "#",
        "Digit4" => "$",
        "Digit5" => "%",
        "Digit6" => "^",
        "Digit7" => "&",
        "Digit8" => "*",
        "Digit9" => "(",
        _ => return None,
    })
}

#[cfg(any(windows, test))]
fn shifted_named_key(code: &str) -> Option<&'static str> {
    Some(match code {
        "Backquote" => "~",
        "Backslash" => "|",
        "BracketLeft" => "{",
        "BracketRight" => "}",
        "Comma" => "<",
        "Equal" => "+",
        "Minus" => "_",
        "Period" => ">",
        "Quote" => "\"",
        "Semicolon" => ":",
        "Slash" => "?",
        _ => return None,
    })
}

#[cfg(any(windows, test))]
fn windows_virtual_key_code(code: &str, key: &str) -> Option<u32> {
    if code.len() == 4 && code.starts_with("Key") {
        return code.as_bytes().get(3).copied().map(u32::from);
    }
    if code.len() == 6 && code.starts_with("Digit") {
        return code.as_bytes().get(5).copied().map(u32::from);
    }
    if let Some(number) = code
        .strip_prefix('F')
        .and_then(|value| value.parse::<u32>().ok())
        && (1..=12).contains(&number)
    {
        return Some(111 + number);
    }
    let named = match code {
        "AltLeft" | "AltRight" => Some(18),
        "ControlLeft" | "ControlRight" => Some(17),
        "MetaLeft" => Some(91),
        "MetaRight" => Some(92),
        "ShiftLeft" | "ShiftRight" => Some(16),
        "Backspace" => Some(8),
        "Tab" => Some(9),
        "Enter" => Some(13),
        "Escape" => Some(27),
        "Space" => Some(32),
        "ArrowLeft" => Some(37),
        "ArrowUp" => Some(38),
        "ArrowRight" => Some(39),
        "ArrowDown" => Some(40),
        "Semicolon" => Some(186),
        "Equal" => Some(187),
        "Comma" => Some(188),
        "Minus" => Some(189),
        "Period" => Some(190),
        "Slash" => Some(191),
        "Backquote" => Some(192),
        "BracketLeft" => Some(219),
        "Backslash" => Some(220),
        "BracketRight" => Some(221),
        "Quote" => Some(222),
        "NumpadMultiply" => Some(106),
        "NumpadAdd" => Some(107),
        "NumpadSubtract" => Some(109),
        "NumpadDecimal" => Some(110),
        "NumpadDivide" => Some(111),
        _ => None,
    };
    named.or_else(|| {
        let mut characters = key.chars();
        let first = characters.next()?;
        characters
            .next()
            .is_none()
            .then(|| first.to_ascii_uppercase() as u32)
    })
}

#[cfg(any(windows, test))]
fn key_location(code: &str) -> Option<u8> {
    if matches!(code, "AltLeft" | "ControlLeft" | "MetaLeft" | "ShiftLeft") {
        Some(1)
    } else if matches!(
        code,
        "AltRight" | "ControlRight" | "MetaRight" | "ShiftRight"
    ) {
        Some(2)
    } else if code.starts_with("Numpad") {
        Some(3)
    } else {
        None
    }
}
