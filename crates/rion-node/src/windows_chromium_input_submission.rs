use napi::{Status, bindgen_prelude::*};
use napi_derive::napi;
#[cfg(any(windows, test))]
use serde::Deserialize;
#[cfg(windows)]
use serde::Serialize;
#[cfg(windows)]
use std::{
    mem::size_of,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use crate::windows_chromium_input_probe::{
    WindowsChromiumInputHwndProbeReceipt, probe_windows_chromium_input_hwnd,
};

#[cfg(windows)]
static DISPATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(any(windows, test))]
#[derive(Clone, Deserialize)]
#[cfg_attr(windows, derive(Serialize))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceIdentity {
    role_id: String,
    surface_generation: u32,
    native_generation: u32,
    binding_revision: String,
    surface_handle_token: String,
    parent_handle_token: String,
}

#[cfg(any(windows, test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeySubmissionRequest {
    #[serde(flatten)]
    identity: SurfaceIdentity,
    probe_revision: String,
    request_id: String,
    input_epoch: String,
    deadline_ms: String,
    delivery_mode: DeliveryMode,
    event_type: KeyEventType,
    code: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    repeat: bool,
}

#[cfg(any(windows, test))]
#[derive(Deserialize)]
#[cfg_attr(windows, derive(Serialize))]
#[serde(rename_all = "camelCase")]
enum KeyEventType {
    KeyDown,
    KeyUp,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[cfg_attr(windows, derive(Serialize))]
#[serde(rename_all = "camelCase")]
enum DeliveryMode {
    Foreground,
    Background,
}

#[cfg(any(windows, test))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MouseSubmissionRequest {
    #[serde(flatten)]
    identity: SurfaceIdentity,
    probe_revision: String,
    request_id: String,
    input_epoch: String,
    deadline_ms: String,
    delivery_mode: DeliveryMode,
    client_x: u32,
    client_y: u32,
    zoom_factor: f64,
    button: u8,
    native_origin_x: i32,
    native_origin_y: i32,
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionReceiptBase {
    #[serde(flatten)]
    identity: SurfaceIdentity,
    status: &'static str,
    request_id: String,
    input_epoch: String,
    delivery_mode: DeliveryMode,
    dispatch_sequence: String,
    probe_revision: String,
    submitted_at_ms: String,
    within_deadline: bool,
    current_process_owned: bool,
    exact_parent: bool,
    child_window_style: bool,
    popup_window_style_absent: bool,
    no_activate_style: bool,
    target_attached: bool,
    no_activation_api_called: bool,
    foreground_window_preserved: bool,
    active_window_preserved: bool,
    focus_window_preserved: bool,
    parent_was_foreground: bool,
    parent_visible: bool,
    surface_visible: bool,
    target_was_foreground: bool,
    target_had_thread_focus: bool,
    client_width: u32,
    client_height: u32,
    dpi: u32,
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeySubmissionReceipt {
    #[serde(flatten)]
    base: SubmissionReceiptBase,
    event_type: KeyEventType,
    code: String,
    virtual_key_code: u32,
    scan_code: u32,
    extended_key: bool,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    keyboard_state_restored: bool,
    dispatched_event_count: u8,
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MouseSubmissionReceipt {
    #[serde(flatten)]
    base: SubmissionReceiptBase,
    button: u8,
    client_x: u32,
    client_y: u32,
    zoom_factor: f64,
    native_client_x: i32,
    native_client_y: i32,
    expected_dom_client_x: f64,
    expected_dom_client_y: f64,
    dispatched_event_count: u8,
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct FocusSnapshot {
    foreground: windows::Win32::Foundation::HWND,
    active: windows::Win32::Foundation::HWND,
    focus: windows::Win32::Foundation::HWND,
}

#[cfg(windows)]
struct ExactBaseReceiptInput<'a> {
    identity: SurfaceIdentity,
    request_id: String,
    input_epoch: String,
    delivery_mode: DeliveryMode,
    probe_revision: String,
    submitted_at_ms: u64,
    before_probe: &'a WindowsChromiumInputHwndProbeReceipt,
    after_probe: &'a WindowsChromiumInputHwndProbeReceipt,
    before: FocusSnapshot,
    after: FocusSnapshot,
    surface: windows::Win32::Foundation::HWND,
    parent: windows::Win32::Foundation::HWND,
}

#[cfg(windows)]
#[napi(js_name = "submitWindowsChromiumBackgroundKey")]
pub fn submit_windows_chromium_background_key(
    surface_handle: Buffer,
    parent_handle: Buffer,
    request_json: String,
) -> Result<String> {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::{
            Input::KeyboardAndMouse::{
                GetKeyboardState, MAPVK_VK_TO_VSC_EX, MapVirtualKeyW, SetKeyboardState, VK_CONTROL,
                VK_LWIN, VK_MENU, VK_SHIFT,
            },
            WindowsAndMessaging::{WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP},
        },
    };

    let request: KeySubmissionRequest = decode_request(&request_json)?;
    validate_key_request(&request)?;
    let deadline_ms = canonical_u64(&request.deadline_ms, "deadline")?;
    let surface = HWND(parse_native_handle(&surface_handle, "surface")? as *mut _);
    let parent = HWND(parse_native_handle(&parent_handle, "parent")? as *mut _);
    let before = focus_snapshot();
    let probe = exact_probe(&surface_handle, &parent_handle, &request.identity)?;
    require_delivery_projection(&probe, request.delivery_mode)?;
    let virtual_key_code = virtual_key_for_code(&request.code).ok_or_else(|| {
        input_error(
            Status::InvalidArg,
            "The DOM code has no locked Win32 virtual-key mapping.",
        )
    })?;
    // SAFETY: the exact current-process/UI-thread HWND was verified immediately
    // above. Keyboard state is restored before any result can be returned.
    let (scan_code, extended_key) = unsafe {
        let mapped = MapVirtualKeyW(u32::from(virtual_key_code), MAPVK_VK_TO_VSC_EX);
        ((mapped & 0xff).max(1), mapped & 0xff00 != 0)
    };
    let mut lparam = 1_u32 | (scan_code << 16);
    if extended_key {
        lparam |= 1 << 24;
    }
    if request.alt {
        lparam |= 1 << 29;
    }
    if matches!(request.event_type, KeyEventType::KeyUp) {
        lparam |= (1 << 30) | (1 << 31);
    }
    let message = match (&request.event_type, request.alt) {
        (KeyEventType::KeyDown, false) => WM_KEYDOWN,
        (KeyEventType::KeyUp, false) => WM_KEYUP,
        (KeyEventType::KeyDown, true) => WM_SYSKEYDOWN,
        (KeyEventType::KeyUp, true) => WM_SYSKEYUP,
    };
    let mut original_keyboard_state = [0_u8; 256];
    // SAFETY: both buffers have the exact Win32-required size. The surface and
    // parent share this calling UI thread, as established by exact_probe.
    unsafe {
        GetKeyboardState(&mut original_keyboard_state).map_err(|_| {
            input_error(
                Status::GenericFailure,
                "Win32 could not capture the exact keyboard state before dispatch.",
            )
        })?;
        let mut requested_keyboard_state = original_keyboard_state;
        set_modifier(&mut requested_keyboard_state, VK_CONTROL.0, request.ctrl);
        set_modifier(&mut requested_keyboard_state, VK_MENU.0, request.alt);
        set_modifier(&mut requested_keyboard_state, VK_SHIFT.0, request.shift);
        set_modifier(&mut requested_keyboard_state, VK_LWIN.0, request.meta);
        if SetKeyboardState(&requested_keyboard_state).is_err() {
            if SetKeyboardState(&original_keyboard_state).is_err() {
                return Err(input_error(
                    Status::GenericFailure,
                    "Win32 rejected keyboard state and exact restoration failed.",
                ));
            }
            return Err(input_error(
                Status::GenericFailure,
                "Win32 rejected the bounded trusted-input keyboard state.",
            ));
        }
        let dispatch = send_message_before_deadline(
            surface,
            message,
            WPARAM(usize::from(virtual_key_code)),
            LPARAM(lparam as isize),
            deadline_ms,
        );
        let restored = SetKeyboardState(&original_keyboard_state).is_ok();
        if !restored {
            return Err(input_error(
                Status::GenericFailure,
                "Win32 could not restore keyboard state after native dispatch.",
            ));
        }
        dispatch?;
    }
    let after_probe = exact_probe(&surface_handle, &parent_handle, &request.identity)?;
    let after = focus_snapshot();
    let submitted_at_ms = current_time_ms()?;
    if submitted_at_ms >= deadline_ms {
        return Err(input_error(
            Status::GenericFailure,
            "The native key dispatch completed after the Core deadline.",
        ));
    }
    let base = exact_base_receipt(ExactBaseReceiptInput {
        identity: request.identity,
        request_id: request.request_id,
        input_epoch: request.input_epoch,
        delivery_mode: request.delivery_mode,
        probe_revision: request.probe_revision,
        submitted_at_ms,
        before_probe: &probe,
        after_probe: &after_probe,
        before,
        after,
        surface,
        parent,
    })?;
    serde_json::to_string(&KeySubmissionReceipt {
        base,
        event_type: request.event_type,
        code: request.code,
        virtual_key_code: u32::from(virtual_key_code),
        scan_code,
        extended_key,
        ctrl: request.ctrl,
        alt: request.alt,
        shift: request.shift,
        meta: request.meta,
        keyboard_state_restored: true,
        dispatched_event_count: 1,
    })
    .map_err(serialization_error)
}

#[cfg(not(windows))]
#[napi(js_name = "submitWindowsChromiumBackgroundKey")]
pub fn submit_windows_chromium_background_key(
    _surface_handle: Buffer,
    _parent_handle: Buffer,
    _request_json: String,
) -> Result<String> {
    Err(platform_unavailable())
}

#[cfg(windows)]
#[napi(js_name = "submitWindowsChromiumBackgroundMouse")]
pub fn submit_windows_chromium_background_mouse(
    surface_handle: Buffer,
    parent_handle: Buffer,
    request_json: String,
) -> Result<String> {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::WindowsAndMessaging::{
            WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN,
            WM_RBUTTONUP,
        },
    };

    let request: MouseSubmissionRequest = decode_request(&request_json)?;
    validate_mouse_request(&request)?;
    let deadline_ms = canonical_u64(&request.deadline_ms, "deadline")?;
    let surface = HWND(parse_native_handle(&surface_handle, "surface")? as *mut _);
    let parent = HWND(parse_native_handle(&parent_handle, "parent")? as *mut _);
    let before = focus_snapshot();
    let probe = exact_probe(&surface_handle, &parent_handle, &request.identity)?;
    require_delivery_projection(&probe, request.delivery_mode)?;
    let native_x = css_to_native(
        request.client_x,
        request.zoom_factor,
        request.native_origin_x,
        probe.dpi,
    )?;
    let native_y = css_to_native(
        request.client_y,
        request.zoom_factor,
        request.native_origin_y,
        probe.dpi,
    )?;
    if native_x < 0
        || native_y < 0
        || native_x >= i32::try_from(probe.client_width).unwrap_or(i32::MAX)
        || native_y >= i32::try_from(probe.client_height).unwrap_or(i32::MAX)
        || native_x > i32::from(i16::MAX)
        || native_y > i32::from(i16::MAX)
    {
        return Err(input_error(
            Status::InvalidArg,
            "The exact Chromium mouse point is outside the native child client bounds.",
        ));
    }
    let (down, up, down_flags) = match request.button {
        0 => (WM_LBUTTONDOWN, WM_LBUTTONUP, 0x0001_usize),
        1 => (WM_MBUTTONDOWN, WM_MBUTTONUP, 0x0010_usize),
        2 => (WM_RBUTTONDOWN, WM_RBUTTONUP, 0x0002_usize),
        _ => unreachable!("validated mouse button"),
    };
    let packed_point = u32::from(native_x as u16) | (u32::from(native_y as u16) << 16);
    // SAFETY: exact_probe established a live same-thread child HWND, and the
    // two synchronous messages are bounded by the caller-owned Core deadline.
    unsafe {
        send_message_before_deadline(
            surface,
            down,
            WPARAM(down_flags),
            LPARAM(packed_point as isize),
            deadline_ms,
        )?;
        send_message_before_deadline(
            surface,
            up,
            WPARAM(0),
            LPARAM(packed_point as isize),
            deadline_ms,
        )?;
    }
    let after_probe = exact_probe(&surface_handle, &parent_handle, &request.identity)?;
    let after = focus_snapshot();
    let submitted_at_ms = current_time_ms()?;
    if submitted_at_ms >= deadline_ms {
        return Err(input_error(
            Status::GenericFailure,
            "The native mouse dispatch completed after the Core deadline.",
        ));
    }
    let base = exact_base_receipt(ExactBaseReceiptInput {
        identity: request.identity,
        request_id: request.request_id,
        input_epoch: request.input_epoch,
        delivery_mode: request.delivery_mode,
        probe_revision: request.probe_revision,
        submitted_at_ms,
        before_probe: &probe,
        after_probe: &after_probe,
        before,
        after,
        surface,
        parent,
    })?;
    serde_json::to_string(&MouseSubmissionReceipt {
        base,
        button: request.button,
        client_x: request.client_x,
        client_y: request.client_y,
        zoom_factor: request.zoom_factor,
        native_client_x: native_x,
        native_client_y: native_y,
        expected_dom_client_x: native_to_css(
            native_x,
            request.zoom_factor,
            request.native_origin_x,
            probe.dpi,
        ),
        expected_dom_client_y: native_to_css(
            native_y,
            request.zoom_factor,
            request.native_origin_y,
            probe.dpi,
        ),
        dispatched_event_count: 2,
    })
    .map_err(serialization_error)
}

#[cfg(not(windows))]
#[napi(js_name = "submitWindowsChromiumBackgroundMouse")]
pub fn submit_windows_chromium_background_mouse(
    _surface_handle: Buffer,
    _parent_handle: Buffer,
    _request_json: String,
) -> Result<String> {
    Err(platform_unavailable())
}

#[cfg(windows)]
fn exact_probe(
    surface_handle: &Buffer,
    parent_handle: &Buffer,
    identity: &SurfaceIdentity,
) -> Result<WindowsChromiumInputHwndProbeReceipt> {
    let receipt = probe_windows_chromium_input_hwnd(
        Buffer::from(surface_handle.as_ref()),
        Buffer::from(parent_handle.as_ref()),
    )?;
    if receipt.surface_handle_token != identity.surface_handle_token
        || receipt.parent_handle_token != identity.parent_handle_token
    {
        return Err(input_error(
            Status::InvalidArg,
            "The exact Win32 child-host identity was superseded before submission.",
        ));
    }
    Ok(receipt)
}

#[cfg(windows)]
fn require_delivery_projection(
    receipt: &WindowsChromiumInputHwndProbeReceipt,
    delivery_mode: DeliveryMode,
) -> Result<()> {
    if !receipt.parent_was_foreground || !receipt.parent_visible {
        return Err(input_error(
            Status::GenericFailure,
            "Windows Chromium trusted input requires the exact visible runtime parent HWND to be foreground.",
        ));
    }
    match delivery_mode {
        DeliveryMode::Foreground if !receipt.surface_visible => Err(input_error(
            Status::GenericFailure,
            "Foreground Windows Chromium input requires the exact native role surface to be visible.",
        )),
        DeliveryMode::Background
            if receipt.surface_visible
                || receipt.target_was_foreground
                || receipt.target_had_thread_focus =>
        {
            Err(input_error(
                Status::GenericFailure,
                "Background Windows Chromium input requires the exact role surface to remain hidden and unfocused.",
            ))
        }
        _ => Ok(()),
    }
}

#[cfg(windows)]
fn exact_base_receipt(input: ExactBaseReceiptInput<'_>) -> Result<SubmissionReceiptBase> {
    let ExactBaseReceiptInput {
        identity,
        request_id,
        input_epoch,
        delivery_mode,
        probe_revision,
        submitted_at_ms,
        before_probe,
        after_probe,
        before,
        after,
        surface,
        parent,
    } = input;
    if before_probe.surface_handle_token != after_probe.surface_handle_token
        || before_probe.parent_handle_token != after_probe.parent_handle_token
        || before_probe.process_id != after_probe.process_id
        || before_probe.ui_thread_id != after_probe.ui_thread_id
        || before_probe.client_width != after_probe.client_width
        || before_probe.client_height != after_probe.client_height
        || before_probe.dpi != after_probe.dpi
        || before_probe.parent_visible != after_probe.parent_visible
        || before_probe.surface_visible != after_probe.surface_visible
    {
        return Err(input_error(
            Status::GenericFailure,
            "The exact Win32 child-host projection changed during native submission.",
        ));
    }
    require_delivery_projection(before_probe, delivery_mode)?;
    require_delivery_projection(after_probe, delivery_mode)?;
    let foreground_window_preserved = before.foreground == after.foreground;
    let active_window_preserved = before.active == after.active;
    let focus_window_preserved = before.focus == after.focus;
    let parent_was_foreground = before.foreground == parent
        && after.foreground == parent
        && before_probe.parent_was_foreground
        && after_probe.parent_was_foreground;
    if !foreground_window_preserved
        || !active_window_preserved
        || !focus_window_preserved
        || !parent_was_foreground
    {
        return Err(input_error(
            Status::GenericFailure,
            "Native input lost the exact foreground runtime parent, activation, or focus owner.",
        ));
    }
    Ok(SubmissionReceiptBase {
        identity,
        status: "submitted",
        request_id,
        input_epoch,
        delivery_mode,
        dispatch_sequence: next_dispatch_sequence()?.to_string(),
        probe_revision,
        submitted_at_ms: submitted_at_ms.to_string(),
        within_deadline: true,
        current_process_owned: true,
        exact_parent: true,
        child_window_style: true,
        popup_window_style_absent: true,
        no_activate_style: true,
        target_attached: true,
        no_activation_api_called: true,
        foreground_window_preserved,
        active_window_preserved,
        focus_window_preserved,
        parent_was_foreground,
        parent_visible: before_probe.parent_visible,
        surface_visible: before_probe.surface_visible,
        target_was_foreground: before.foreground == surface,
        target_had_thread_focus: before.focus == surface,
        client_width: before_probe.client_width,
        client_height: before_probe.client_height,
        dpi: before_probe.dpi,
    })
}

#[cfg(windows)]
fn focus_snapshot() -> FocusSnapshot {
    use windows::Win32::UI::{
        Input::KeyboardAndMouse::{GetActiveWindow, GetFocus},
        WindowsAndMessaging::GetForegroundWindow,
    };
    // SAFETY: these calls read the calling UI thread/process state only.
    unsafe {
        FocusSnapshot {
            foreground: GetForegroundWindow(),
            active: GetActiveWindow(),
            focus: GetFocus(),
        }
    }
}

#[cfg(windows)]
unsafe fn send_message_before_deadline(
    target: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    deadline_ms: u64,
) -> Result<()> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SEND_MESSAGE_TIMEOUT_FLAGS, SMTO_ABORTIFHUNG, SMTO_BLOCK, SMTO_ERRORONEXIT,
        SendMessageTimeoutW,
    };
    let now_ms = current_time_ms()?;
    let remaining = deadline_ms
        .checked_sub(now_ms)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            input_error(
                Status::GenericFailure,
                "The Core input deadline expired before native dispatch.",
            )
        })?;
    let timeout_ms = u32::try_from(remaining).unwrap_or(u32::MAX);
    let flags = SEND_MESSAGE_TIMEOUT_FLAGS(SMTO_ABORTIFHUNG.0 | SMTO_BLOCK.0 | SMTO_ERRORONEXIT.0);
    let mut message_result = 0_usize;
    // SAFETY: the caller proved target is a live same-process HWND. The call is
    // synchronous and bounded by the explicit external Core deadline.
    let dispatch = unsafe {
        SendMessageTimeoutW(
            target,
            message,
            wparam,
            lparam,
            flags,
            timeout_ms,
            Some(&raw mut message_result),
        )
    };
    if dispatch.0 == 0 {
        return Err(input_error(
            Status::GenericFailure,
            "Win32 did not return an exact native input dispatch receipt.",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn parse_native_handle(buffer: &Buffer, field: &str) -> Result<usize> {
    if buffer.len() != size_of::<usize>() {
        return Err(input_error(
            Status::InvalidArg,
            format!("Electron returned an invalid {field} native-handle width."),
        ));
    }
    let mut bytes = [0_u8; size_of::<usize>()];
    bytes.copy_from_slice(buffer.as_ref());
    let address = usize::from_ne_bytes(bytes);
    if address == 0 {
        return Err(input_error(
            Status::InvalidArg,
            format!("Electron returned a null {field} native handle."),
        ));
    }
    Ok(address)
}

#[cfg(windows)]
fn current_time_ms() -> Result<u64> {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| {
        input_error(
            Status::GenericFailure,
            "The system clock is earlier than the Unix epoch.",
        )
    })?;
    u64::try_from(duration.as_millis()).map_err(|_| {
        input_error(
            Status::GenericFailure,
            "The current time cannot be represented by the input receipt.",
        )
    })
}

#[cfg(windows)]
fn next_dispatch_sequence() -> Result<u64> {
    DISPATCH_SEQUENCE
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            value.checked_add(1)
        })
        .map(|prior| prior + 1)
        .map_err(|_| {
            input_error(
                Status::GenericFailure,
                "The native input dispatch sequence was exhausted.",
            )
        })
}

#[cfg(windows)]
fn set_modifier(state: &mut [u8; 256], virtual_key: u16, pressed: bool) {
    let slot = &mut state[usize::from(virtual_key)];
    *slot = (*slot & 0x7f) | if pressed { 0x80 } else { 0 };
}

#[cfg(any(windows, test))]
fn decode_request<Value: for<'de> Deserialize<'de>>(json: &str) -> Result<Value> {
    if json.is_empty() || json.len() > 16 * 1024 {
        return Err(input_error(
            Status::InvalidArg,
            "The native input request exceeds its bounded canonical envelope.",
        ));
    }
    serde_json::from_str(json).map_err(|_| {
        input_error(
            Status::InvalidArg,
            "The native input request is malformed or contains unsupported fields.",
        )
    })
}

#[cfg(any(windows, test))]
fn validate_identity(identity: &SurfaceIdentity) -> Result<()> {
    validate_identifier(&identity.role_id, "role")?;
    if identity.surface_generation == 0 || identity.native_generation == 0 {
        return Err(input_error(
            Status::InvalidArg,
            "Positive surface and native generations are required.",
        ));
    }
    canonical_u64(&identity.binding_revision, "binding revision")?;
    if !is_handle_token(&identity.surface_handle_token)
        || !is_handle_token(&identity.parent_handle_token)
        || identity.surface_handle_token == identity.parent_handle_token
    {
        return Err(input_error(
            Status::InvalidArg,
            "The native input request has invalid opaque handle evidence.",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_key_request(request: &KeySubmissionRequest) -> Result<()> {
    validate_identity(&request.identity)?;
    validate_common_request(
        &request.request_id,
        &request.input_epoch,
        &request.probe_revision,
    )?;
    canonical_u64(&request.deadline_ms, "deadline")?;
    let _exact_event_and_modifiers = (
        &request.event_type,
        request.ctrl,
        request.alt,
        request.shift,
        request.meta,
    );
    if request.repeat || virtual_key_for_code(&request.code).is_none() {
        return Err(input_error(
            Status::InvalidArg,
            "The native key request contains an unsupported DOM code or repeat state.",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_mouse_request(request: &MouseSubmissionRequest) -> Result<()> {
    validate_identity(&request.identity)?;
    validate_common_request(
        &request.request_id,
        &request.input_epoch,
        &request.probe_revision,
    )?;
    canonical_u64(&request.deadline_ms, "deadline")?;
    if request.button > 2
        || !request.zoom_factor.is_finite()
        || !(0.25..=5.0).contains(&request.zoom_factor)
        || request.client_x > 1_000_000
        || request.client_y > 1_000_000
        || request.native_origin_x.unsigned_abs() > 1_000_000
        || request.native_origin_y.unsigned_abs() > 1_000_000
    {
        return Err(input_error(
            Status::InvalidArg,
            "The native mouse request contains an invalid point, button, or zoom.",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_common_request(
    request_id: &str,
    input_epoch: &str,
    probe_revision: &str,
) -> Result<()> {
    validate_identifier(request_id, "request")?;
    canonical_u64(input_epoch, "input epoch")?;
    canonical_u64(probe_revision, "probe revision")?;
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_identifier(value: &str, field: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 256
        || value.trim() != value
        || value.contains('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(input_error(
            Status::InvalidArg,
            format!("The native input {field} identity is not canonical."),
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn canonical_u64(value: &str, field: &str) -> Result<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(input_error(
            Status::InvalidArg,
            format!("The native input {field} is not a canonical u64."),
        ));
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            input_error(
                Status::InvalidArg,
                format!("The native input {field} must be a positive u64."),
            )
        })
}

#[cfg(any(windows, test))]
fn is_handle_token(value: &str) -> bool {
    (32..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(any(windows, test))]
fn virtual_key_for_code(code: &str) -> Option<u16> {
    if let Some(letter) = code.strip_prefix("Key")
        && letter.len() == 1
        && letter.as_bytes()[0].is_ascii_uppercase()
    {
        return Some(u16::from(letter.as_bytes()[0]));
    }
    if let Some(digit) = code.strip_prefix("Digit")
        && digit.len() == 1
        && digit.as_bytes()[0].is_ascii_digit()
    {
        return Some(u16::from(digit.as_bytes()[0]));
    }
    if let Some(function) = code.strip_prefix('F')
        && let Ok(number) = function.parse::<u16>()
        && (1..=24).contains(&number)
    {
        return Some(0x6f + number);
    }
    Some(match code {
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Enter" => 0x0d,
        "Escape" => 0x1b,
        "Space" => 0x20,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Insert" => 0x2d,
        "Delete" => 0x2e,
        "Semicolon" => 0xba,
        "Equal" => 0xbb,
        "Comma" => 0xbc,
        "Minus" => 0xbd,
        "Period" => 0xbe,
        "Slash" => 0xbf,
        "Backquote" => 0xc0,
        "BracketLeft" => 0xdb,
        "Backslash" => 0xdc,
        "BracketRight" => 0xdd,
        "Quote" => 0xde,
        _ => return None,
    })
}

#[cfg(any(windows, test))]
fn css_to_native(css: u32, zoom: f64, origin: i32, dpi: u32) -> Result<i32> {
    let device_scale = f64::from(dpi) / 96.0;
    let scaled = (f64::from(css) * zoom + f64::from(origin)) * device_scale;
    if !scaled.is_finite() || scaled < f64::from(i32::MIN) || scaled > f64::from(i32::MAX) {
        return Err(input_error(
            Status::InvalidArg,
            "The Chromium CSS point cannot be represented by Win32.",
        ));
    }
    Ok(scaled.round() as i32)
}

#[cfg(any(windows, test))]
fn native_to_css(native: i32, zoom: f64, origin: i32, dpi: u32) -> f64 {
    let device_scale = f64::from(dpi) / 96.0;
    (f64::from(native) / device_scale - f64::from(origin)) / zoom
}

#[cfg(not(windows))]
fn platform_unavailable() -> Error {
    input_error(
        Status::GenericFailure,
        "Native Chromium background input is available only on Windows.",
    )
}

#[cfg(windows)]
fn serialization_error(error: serde_json::Error) -> Error {
    input_error(
        Status::GenericFailure,
        format!("Could not serialize the native input receipt: {error}"),
    )
}

fn input_error(status: Status, message: impl Into<String>) -> Error {
    Error::new(status, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dom_codes_have_locked_virtual_key_mappings() {
        assert_eq!(virtual_key_for_code("KeyA"), Some(0x41));
        assert_eq!(virtual_key_for_code("Digit9"), Some(0x39));
        assert_eq!(virtual_key_for_code("F24"), Some(0x87));
        assert_eq!(virtual_key_for_code("ArrowLeft"), Some(0x25));
        assert_eq!(virtual_key_for_code("Numpad1"), None);
    }

    #[test]
    fn canonical_u64_and_handle_tokens_reject_ambiguous_values() {
        assert_eq!(canonical_u64("1", "revision").unwrap(), 1);
        assert!(canonical_u64("01", "revision").is_err());
        assert!(canonical_u64("0", "revision").is_err());
        assert!(is_handle_token(&"a".repeat(64)));
        assert!(!is_handle_token(&"A".repeat(64)));
    }

    #[test]
    fn strict_request_decoder_rejects_unknown_fields() {
        let canonical = serde_json::json!({
            "roleId": "role-1",
            "surfaceGeneration": 1,
            "nativeGeneration": 1,
            "bindingRevision": "1",
            "surfaceHandleToken": "a".repeat(64),
            "parentHandleToken": "b".repeat(64),
            "probeRevision": "1",
            "requestId": "request-1",
            "inputEpoch": "1",
            "deadlineMs": "2",
            "deliveryMode": "foreground",
            "eventType": "keyDown",
            "code": "KeyA",
            "ctrl": false,
            "alt": false,
            "shift": false,
            "meta": false,
            "repeat": false
        });
        let decoded = decode_request::<KeySubmissionRequest>(&canonical.to_string()).unwrap();
        validate_key_request(&decoded).unwrap();
        assert_eq!(decoded.delivery_mode, DeliveryMode::Foreground);
        let mut legacy = canonical.clone();
        legacy
            .as_object_mut()
            .expect("canonical request object")
            .remove("deliveryMode");
        assert!(decode_request::<KeySubmissionRequest>(&legacy.to_string()).is_err());
        let mut malformed = canonical;
        malformed["unexpected"] = serde_json::Value::Bool(true);
        assert!(decode_request::<KeySubmissionRequest>(&malformed.to_string()).is_err());
    }

    #[test]
    fn mouse_request_validation_is_bounded() {
        let canonical = serde_json::json!({
            "roleId": "role-1",
            "surfaceGeneration": 1,
            "nativeGeneration": 1,
            "bindingRevision": "1",
            "surfaceHandleToken": "a".repeat(64),
            "parentHandleToken": "b".repeat(64),
            "probeRevision": "1",
            "requestId": "request-1",
            "inputEpoch": "1",
            "deadlineMs": "2",
            "deliveryMode": "background",
            "clientX": 10,
            "clientY": 20,
            "zoomFactor": 1.25,
            "button": 0,
            "nativeOriginX": 2,
            "nativeOriginY": 3
        });
        let decoded = decode_request::<MouseSubmissionRequest>(&canonical.to_string()).unwrap();
        validate_mouse_request(&decoded).unwrap();
        assert_eq!(decoded.delivery_mode, DeliveryMode::Background);
    }

    #[test]
    fn mouse_coordinates_scale_dips_to_physical_win32_pixels() {
        let native = css_to_native(80, 1.25, 20, 144).unwrap();
        assert_eq!(native, 180);
        assert_eq!(native_to_css(native, 1.25, 20, 144), 80.0);
        assert_eq!(css_to_native(80, 1.0, 0, 120).unwrap(), 100);
    }
}
