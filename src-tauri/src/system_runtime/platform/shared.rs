// shared system-runtime adapter; definitions keep explicit compile-time cfg boundaries.

fn key_prefix_compensation(
    effects: &[EmbeddedKeyEffectRecord],
) -> Vec<EmbeddedKeyEffectRecord> {
    let Some(first) = effects.first() else {
        return Vec::new();
    };
    let initial = first
        .active_codes_before
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let current = effects
        .last()
        .map(|effect| effect.active_codes.iter().cloned().collect::<HashSet<_>>())
        .unwrap_or_default();
    let mut active = current.clone();
    let mut releases = current.difference(&initial).cloned().collect::<Vec<_>>();
    releases.sort_by_key(|code| (is_modifier_input_code(code), code.clone()));
    let mut presses = initial.difference(&current).cloned().collect::<Vec<_>>();
    presses.sort_by_key(|code| (!is_modifier_input_code(code), code.clone()));
    let mut compensation = Vec::with_capacity(releases.len() + presses.len());
    for code in releases {
        let before = sorted_input_codes(&active);
        active.remove(&code);
        compensation.push(EmbeddedKeyEffectRecord {
            phase: "keyUp".to_owned(),
            code: code.clone(),
            active_codes_before: before,
            active_codes: sorted_input_codes(&active),
            auto_repeat: false,
            suppress_shortcut: !is_modifier_input_code(&code),
        });
    }
    for code in presses {
        let before = sorted_input_codes(&active);
        active.insert(code.clone());
        compensation.push(EmbeddedKeyEffectRecord {
            phase: "rawKeyDown".to_owned(),
            code: code.clone(),
            active_codes_before: before,
            active_codes: sorted_input_codes(&active),
            auto_repeat: false,
            suppress_shortcut: !is_modifier_input_code(&code),
        });
    }
    compensation
}

fn release_reasserted_key_effects(
    effects: &[EmbeddedKeyEffectRecord],
) -> Vec<EmbeddedKeyEffectRecord> {
    let mut active = effects
        .iter()
        .map(|effect| effect.code.clone())
        .collect::<HashSet<_>>();
    let mut codes = active.iter().cloned().collect::<Vec<_>>();
    codes.sort_by_key(|code| (is_modifier_input_code(code), code.clone()));
    codes
        .into_iter()
        .map(|code| {
            let before = sorted_input_codes(&active);
            active.remove(&code);
            EmbeddedKeyEffectRecord {
                phase: "keyUp".to_owned(),
                code: code.clone(),
                active_codes_before: before,
                active_codes: sorted_input_codes(&active),
                auto_repeat: false,
                suppress_shortcut: !is_modifier_input_code(&code),
            }
        })
        .collect()
}

fn sorted_input_codes(codes: &HashSet<String>) -> Vec<String> {
    let mut codes = codes.iter().cloned().collect::<Vec<_>>();
    codes.sort();
    codes
}

fn is_modifier_input_code(code: &str) -> bool {
    matches!(
        code,
        "AltLeft"
            | "AltRight"
            | "ControlLeft"
            | "ControlRight"
            | "MetaLeft"
            | "MetaRight"
            | "ShiftLeft"
            | "ShiftRight"
    )
}

fn physical_modifier_projection_effects(
    effect: &EmbeddedKeyEffectRecord,
    physical_modifier_codes: &[String],
    mut is_physically_pressed: impl FnMut(&str) -> bool,
) -> Vec<EmbeddedKeyEffectRecord> {
    let mut active = effect.active_codes.iter().cloned().collect::<HashSet<_>>();
    physical_modifier_codes
        .iter()
        .filter_map(|code| {
            if active.contains(code) || !is_physically_pressed(code) {
                return None;
            }
            let active_codes_before = sorted_input_codes(&active);
            active.insert(code.clone());
            Some(EmbeddedKeyEffectRecord {
                phase: "rawKeyDown".to_owned(),
                code: code.clone(),
                active_codes_before,
                active_codes: sorted_input_codes(&active),
                auto_repeat: false,
                suppress_shortcut: false,
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Default)]
struct MouseInputDispatchDiagnostics {
    down_completion: Duration,
    handoff_wait: Duration,
    press_duration: Duration,
    up_completion: Option<Duration>,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy)]
struct MouseInputDispatchPolicy {
    handoff_interval: Duration,
    press_interval: Duration,
}

#[derive(Debug)]
struct MouseInputSequenceError {
    action: RuntimeError,
    cleanup: Option<RuntimeError>,
    diagnostics: MouseInputDispatchDiagnostics,
    down_confirmed: bool,
}

fn dispatch_mouse_input_sequence(
    context: &InputDispatchContext,
    mut cleanup_context: impl FnMut() -> InputDispatchContext,
    mut diagnostics: MouseInputDispatchDiagnostics,
    mut after_down_submission: impl FnMut(),
    mut dispatch: impl FnMut(bool, &InputDispatchContext) -> RuntimeResult<()>,
) -> Result<MouseInputDispatchDiagnostics, Box<MouseInputSequenceError>> {
    let down_started = Instant::now();
    let down_result = dispatch(true, context);
    diagnostics.down_completion = down_started.elapsed();
    match down_result {
        Ok(()) => {
            let press_started = Instant::now();
            after_down_submission();
            let cleanup = cleanup_context();
            let up_started = Instant::now();
            diagnostics.press_duration = press_started.elapsed();
            let up_result = dispatch(false, &cleanup);
            diagnostics.up_completion = Some(up_started.elapsed());
            match up_result {
                Ok(()) => Ok(diagnostics),
                Err(action) if action.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" => {
                    let cleanup = cleanup_context();
                    let cleanup_error = dispatch(false, &cleanup).err();
                    let action = if cleanup_error.is_none() {
                        action.with_confirmed_input_neutrality()
                    } else {
                        action
                    };
                    Err(Box::new(MouseInputSequenceError {
                        action,
                        cleanup: cleanup_error,
                        diagnostics,
                        down_confirmed: true,
                    }))
                }
                Err(action) => Err(Box::new(MouseInputSequenceError {
                    action,
                    cleanup: None,
                    diagnostics,
                    down_confirmed: true,
                })),
            }
        }
        Err(mut action) if action.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" => {
            let press_started = Instant::now();
            after_down_submission();
            let cleanup = cleanup_context();
            let up_started = Instant::now();
            diagnostics.press_duration = press_started.elapsed();
            let cleanup_error = dispatch(false, &cleanup).err();
            diagnostics.up_completion = Some(up_started.elapsed());
            if cleanup_error.is_none() {
                action = action.with_confirmed_input_neutrality();
            }
            Err(Box::new(MouseInputSequenceError {
                action,
                cleanup: cleanup_error,
                diagnostics,
                down_confirmed: false,
            }))
        }
        Err(action) => Err(Box::new(MouseInputSequenceError {
            action,
            cleanup: None,
            diagnostics,
            down_confirmed: false,
        })),
    }
}

#[cfg(any(target_os = "macos", test))]
fn dispatch_coordinated_mouse_input_sequence(
    coordinator: &Mutex<Option<String>>,
    role_label: &str,
    policy: MouseInputDispatchPolicy,
    context: &InputDispatchContext,
    cleanup_context: impl FnMut() -> InputDispatchContext,
    mut sleep: impl FnMut(Duration),
    dispatch: impl FnMut(bool, &InputDispatchContext) -> RuntimeResult<()>,
) -> Result<MouseInputDispatchDiagnostics, Box<MouseInputSequenceError>> {
    let mut previous_role_label = coordinator.lock().map_err(|_| {
        Box::new(MouseInputSequenceError {
            action: RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The mouse dispatch coordinator was poisoned.",
            ),
            cleanup: None,
            diagnostics: MouseInputDispatchDiagnostics::default(),
            down_confirmed: false,
        })
    })?;
    let mut diagnostics = MouseInputDispatchDiagnostics::default();
    if previous_role_label
        .as_deref()
        .is_some_and(|previous| previous != role_label)
    {
        context.ensure_current().map_err(|action| {
            Box::new(MouseInputSequenceError {
                action,
                cleanup: None,
                diagnostics,
                down_confirmed: false,
            })
        })?;
        let handoff_started = Instant::now();
        sleep(policy.handoff_interval);
        diagnostics.handoff_wait = handoff_started.elapsed();
        context.ensure_current().map_err(|action| {
            Box::new(MouseInputSequenceError {
                action,
                cleanup: None,
                diagnostics,
                down_confirmed: false,
            })
        })?;
    }
    dispatch_mouse_input_sequence(
        context,
        cleanup_context,
        diagnostics,
        || {
            // An indeterminate native callback may still have submitted mouseDown.
            // Conservatively remember its target before cleanup and the next handoff.
            *previous_role_label = Some(role_label.to_owned());
            sleep(policy.press_interval);
        },
        dispatch,
    )
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
    applied_page_zoom: f64,
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
        "reference-px" => {
            let zoom = validate_applied_page_zoom(applied_page_zoom)?;
            (
                viewport.width * anchor_x / 100.0 + x / zoom,
                viewport.height * anchor_y / 100.0 + y / zoom,
            )
        }
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
    _high_refresh_rate_enabled: bool,
    _contained_fullscreen_enabled: bool,
) -> (
    WebviewBuilder<tauri::Wry>,
    HighRefreshRateDiagnosticStatus,
    RoleWebGlConfiguration,
) {
    (
        builder,
        HighRefreshRateDiagnosticStatus::NotApplicable,
        RoleWebGlConfiguration::windows(),
    )
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
    if virtual_key == 0x51 {
        return (control && !alt && !meta && !shift && !repeat)
            .then_some(ApplicationShortcutCommand::QuitApplication);
    }
    windows_role_zoom_action(virtual_key, control, alt, meta, shift).map(|action| match action {
        "in" => ApplicationShortcutCommand::ZoomIn,
        "out" => ApplicationShortcutCommand::ZoomOut,
        _ => ApplicationShortcutCommand::ZoomReset,
    })
}

#[cfg(any(windows, test))]
fn windows_quick_access_shortcut(
    virtual_key: u32,
    control: bool,
    alt: bool,
    meta: bool,
    shift: bool,
    repeat: bool,
) -> bool {
    virtual_key == 0x4B && control && !alt && !meta && !shift && !repeat
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

#[cfg(test)]
fn macos_quick_access_shortcut(
    key_code: u16,
    command: bool,
    control: bool,
    option: bool,
    shift: bool,
    repeat: bool,
) -> bool {
    key_code == 40 && command && !control && !option && !shift && !repeat
}

#[cfg(not(windows))]
fn install_platform_navigation_completion_tracker(
    _webview: &Webview,
    _navigation: Arc<NavigationTracker>,
) -> RuntimeResult<()> {
    Ok(())
}

#[cfg(not(windows))]
fn platform_role_surface_setup(
    webview: &Webview,
    app: AppHandle,
    target: SurfaceFailureTarget,
    _navigation: Arc<NavigationTracker>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InputTransactionStage {
    Dispatch,
    DomAcknowledgement,
    Guard,
}

impl InputTransactionStage {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Dispatch => "dispatch",
            Self::DomAcknowledgement => "domAcknowledgement",
            Self::Guard => "guard",
        }
    }
}

#[derive(Debug)]
pub(crate) struct RuntimeError {
    pub(crate) code: &'static str,
    diagnostic: Option<RuntimeErrorDiagnostic>,
    input_neutrality_confirmed: bool,
    input_transaction_stage: Option<InputTransactionStage>,
    pub(crate) message: String,
    rollback_error_count: Option<u32>,
}

impl RuntimeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            diagnostic: None,
            input_neutrality_confirmed: false,
            input_transaction_stage: None,
            message: message.into(),
            rollback_error_count: None,
        }
    }

    fn with_confirmed_input_neutrality(mut self) -> Self {
        self.input_neutrality_confirmed = true;
        self
    }

    const fn input_neutrality_confirmed(&self) -> bool {
        self.input_neutrality_confirmed
    }

    fn with_input_transaction_stage(mut self, stage: InputTransactionStage) -> Self {
        if self.input_transaction_stage.is_none() {
            self.input_transaction_stage = Some(stage);
        }
        self
    }

    fn with_rollback_error_count(mut self, count: usize) -> Self {
        self.rollback_error_count = Some(count.min(u32::MAX as usize) as u32);
        self
    }

    #[cfg(windows)]
    fn with_setup_diagnostic(
        mut self,
        setup_stage: &'static str,
        native_code: Option<String>,
    ) -> Self {
        self.diagnostic = Some(RuntimeErrorDiagnostic {
            native_code,
            setup_stage,
        });
        self
    }

    fn io(error: std::io::Error) -> Self {
        Self::new("TAURI_RUNTIME_IO_FAILED", error.to_string())
    }

    fn tauri(error: impl std::fmt::Display) -> Self {
        Self::new("TAURI_RUNTIME_FAILED", error.to_string())
    }

    fn core(error: impl std::fmt::Display) -> Self {
        Self::new("TAURI_CORE_COMMAND_FAILED", error.to_string())
    }
}
