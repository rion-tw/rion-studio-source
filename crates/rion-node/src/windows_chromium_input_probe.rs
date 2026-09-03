use napi::{Status, bindgen_prelude::*};
use napi_derive::napi;
#[cfg(any(windows, test))]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::mem::size_of;

const WINDOWS_CHROMIUM_INPUT_PROBE_ABI_VERSION: u32 = 3;

#[napi(object)]
pub struct WindowsChromiumInputHwndProbeReceipt {
    pub abi_version: u32,
    pub surface_handle_token: String,
    pub parent_handle_token: String,
    pub process_id: u32,
    pub ui_thread_id: u32,
    pub parent_ui_thread_id: u32,
    pub current_process_owned: bool,
    pub exact_parent: bool,
    pub child_window_style: bool,
    pub popup_window_style_absent: bool,
    pub no_activate_style: bool,
    pub foreground_window_preserved: bool,
    pub active_window_preserved: bool,
    pub focus_window_preserved: bool,
    pub parent_was_foreground: bool,
    pub parent_visible: bool,
    pub surface_visible: bool,
    pub target_was_foreground: bool,
    pub target_had_thread_focus: bool,
    pub client_width: u32,
    pub client_height: u32,
    pub dpi: u32,
}

#[napi(object)]
pub struct WindowsRuntimeForegroundReadback {
    pub parent_identity: String,
    pub parent_was_foreground: bool,
    pub parent_visible: bool,
    pub parent_minimized: bool,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowsRuntimeForegroundFacts {
    parent_address: usize,
    current_process_id: u32,
    owner_process_id_before: u32,
    owner_process_id_after: u32,
    owner_thread_id_before: u32,
    owner_thread_id_after: u32,
    valid_before: bool,
    valid_after: bool,
    foreground_before: usize,
    foreground_after: usize,
    active_before: usize,
    active_after: usize,
    focus_before: usize,
    focus_after: usize,
    visible_before: bool,
    visible_after: bool,
    minimized_before: bool,
    minimized_after: bool,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WindowsRuntimeForegroundFactError {
    InvalidParent,
    OwnershipUnavailable,
    ForeignOwner,
    OwnerChanged,
    ObservationChanged,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowsRuntimeForegroundState {
    owner_thread_id: u32,
    parent_was_foreground: bool,
    parent_visible: bool,
    parent_minimized: bool,
}

#[napi(js_name = "windowsChromiumInputProbeAbiVersion")]
pub fn windows_chromium_input_probe_abi_version() -> u32 {
    WINDOWS_CHROMIUM_INPUT_PROBE_ABI_VERSION
}

/// Reads the exact Electron runtime parent without requesting activation.
///
/// The opaque identity is process- and UI-thread-bound. Foreground, active,
/// focus, visibility, and minimized state must remain stable for the complete
/// query; a concurrent native transition fails closed instead of returning a
/// mixed observation.
#[cfg(windows)]
#[napi(js_name = "readWindowsRuntimeForeground")]
pub fn read_windows_runtime_foreground(
    parent_handle: Buffer,
) -> Result<WindowsRuntimeForegroundReadback> {
    use windows::Win32::{
        Foundation::HWND,
        System::Threading::GetCurrentProcessId,
        UI::{
            Input::KeyboardAndMouse::{GetActiveWindow, GetFocus},
            WindowsAndMessaging::{
                GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
            },
        },
    };

    let parent_address = parse_electron_native_handle(&parent_handle, "parent")?;
    let parent = HWND(parent_address as *mut core::ffi::c_void);

    // SAFETY: the HWND is never dereferenced. Every call is a read-only User32
    // query, bracketed by exact identity and focus-state observations.
    unsafe {
        let valid_before = IsWindow(Some(parent)).as_bool();
        let foreground_before = GetForegroundWindow().0 as usize;
        let active_before = GetActiveWindow().0 as usize;
        let focus_before = GetFocus().0 as usize;
        let current_process_id = GetCurrentProcessId();
        let mut owner_process_id_before = 0;
        let owner_thread_id_before =
            GetWindowThreadProcessId(parent, Some(&raw mut owner_process_id_before));
        let visible_before = IsWindowVisible(parent).as_bool();
        let minimized_before = IsIconic(parent).as_bool();

        let valid_after = IsWindow(Some(parent)).as_bool();
        let mut owner_process_id_after = 0;
        let owner_thread_id_after =
            GetWindowThreadProcessId(parent, Some(&raw mut owner_process_id_after));
        let visible_after = IsWindowVisible(parent).as_bool();
        let minimized_after = IsIconic(parent).as_bool();
        let foreground_after = GetForegroundWindow().0 as usize;
        let active_after = GetActiveWindow().0 as usize;
        let focus_after = GetFocus().0 as usize;

        let state = classify_windows_runtime_foreground(WindowsRuntimeForegroundFacts {
            parent_address,
            current_process_id,
            owner_process_id_before,
            owner_process_id_after,
            owner_thread_id_before,
            owner_thread_id_after,
            valid_before,
            valid_after,
            foreground_before,
            foreground_after,
            active_before,
            active_after,
            focus_before,
            focus_after,
            visible_before,
            visible_after,
            minimized_before,
            minimized_after,
        })
        .map_err(windows_runtime_foreground_error)?;

        Ok(WindowsRuntimeForegroundReadback {
            parent_identity: windows_runtime_parent_identity(
                parent_address,
                current_process_id,
                state.owner_thread_id,
            ),
            parent_was_foreground: state.parent_was_foreground,
            parent_visible: state.parent_visible,
            parent_minimized: state.parent_minimized,
        })
    }
}

#[cfg(not(windows))]
#[napi(js_name = "readWindowsRuntimeForeground")]
pub fn read_windows_runtime_foreground(
    _parent_handle: Buffer,
) -> Result<WindowsRuntimeForegroundReadback> {
    Err(probe_error(
        Status::GenericFailure,
        "The Win32 runtime-parent foreground readback is available only on Windows.",
    ))
}

/// Read-only Win32 preflight for a caller-owned, dedicated Electron BaseWindow.
///
/// This does not discover a Chromium HWND and never mutates parent, style,
/// visibility, activation, or focus. The caller must provide both handles from
/// Electron's public `BaseWindow.getNativeWindowHandle()` API. A receipt proves
/// only native ownership/attachment facts; a separate Electron ownership ledger
/// and physical Windows compositor/DOM probe must prove that the child contains
/// exactly one live role WebContents before the capability can be advertised.
#[cfg(windows)]
#[napi(js_name = "probeWindowsChromiumInputHwnd")]
pub fn probe_windows_chromium_input_hwnd(
    surface_handle: Buffer,
    parent_handle: Buffer,
) -> Result<WindowsChromiumInputHwndProbeReceipt> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        System::Threading::{GetCurrentProcessId, GetCurrentThreadId},
        UI::{
            HiDpi::GetDpiForWindow,
            Input::KeyboardAndMouse::{GetActiveWindow, GetFocus},
            WindowsAndMessaging::{
                GWL_EXSTYLE, GWL_STYLE, GetClientRect, GetForegroundWindow, GetParent,
                GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, WS_CHILD,
                WS_EX_NOACTIVATE, WS_POPUP,
            },
        },
    };

    let surface_address = parse_electron_native_handle(&surface_handle, "surface")?;
    let parent_address = parse_electron_native_handle(&parent_handle, "parent")?;
    if surface_address == parent_address {
        return Err(probe_error(
            Status::InvalidArg,
            "The Windows Chromium input surface cannot be its own parent.",
        ));
    }
    let surface = HWND(surface_address as *mut core::ffi::c_void);
    let parent = HWND(parent_address as *mut core::ffi::c_void);

    // SAFETY: no handle is dereferenced. Every operation is a read-only User32
    // query after IsWindow, and all failures terminalize without mutation.
    unsafe {
        if !IsWindow(Some(surface)).as_bool() || !IsWindow(Some(parent)).as_bool() {
            return Err(probe_error(
                Status::InvalidArg,
                "Electron supplied a stale or invalid Windows native handle.",
            ));
        }
        let foreground_before = GetForegroundWindow();
        let active_before = GetActiveWindow();
        let focus_before = GetFocus();
        let current_process_id = GetCurrentProcessId();
        let mut surface_process_id = 0;
        let surface_thread_id =
            GetWindowThreadProcessId(surface, Some(&raw mut surface_process_id));
        let mut parent_process_id = 0;
        let parent_thread_id = GetWindowThreadProcessId(parent, Some(&raw mut parent_process_id));
        if surface_thread_id == 0 || parent_thread_id == 0 {
            return Err(probe_error(
                Status::GenericFailure,
                "Win32 could not read the exact Electron window ownership.",
            ));
        }
        let current_thread_id = GetCurrentThreadId();
        let current_process_owned =
            surface_process_id == current_process_id && parent_process_id == current_process_id;
        if !current_process_owned
            || surface_thread_id != parent_thread_id
            || surface_thread_id != current_thread_id
        {
            return Err(probe_error(
                Status::InvalidArg,
                "The Windows Chromium input child and parent must share the calling Electron UI owner.",
            ));
        }
        let exact_parent = GetParent(surface).is_ok_and(|owner| owner == parent);
        let style = GetWindowLongPtrW(surface, GWL_STYLE) as u32;
        let extended_style = GetWindowLongPtrW(surface, GWL_EXSTYLE) as u32;
        let child_window_style = style & WS_CHILD.0 != 0;
        let popup_window_style_absent = style & WS_POPUP.0 == 0;
        let no_activate_style = extended_style & WS_EX_NOACTIVATE.0 != 0;
        if !exact_parent || !child_window_style || !popup_window_style_absent || !no_activate_style
        {
            return Err(probe_error(
                Status::InvalidArg,
                "The Electron surface is not an exact no-activate WS_CHILD of the runtime host.",
            ));
        }
        let mut client_rect = RECT::default();
        GetClientRect(surface, &raw mut client_rect).map_err(|_| {
            probe_error(
                Status::GenericFailure,
                "Win32 could not read the exact input-surface client bounds.",
            )
        })?;
        let width = client_rect
            .right
            .checked_sub(client_rect.left)
            .ok_or_else(|| {
                probe_error(
                    Status::GenericFailure,
                    "The Windows Chromium input-surface width overflowed.",
                )
            })?;
        let height = client_rect
            .bottom
            .checked_sub(client_rect.top)
            .ok_or_else(|| {
                probe_error(
                    Status::GenericFailure,
                    "The Windows Chromium input-surface height overflowed.",
                )
            })?;
        let client_width = u32::try_from(width)
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                probe_error(
                    Status::InvalidArg,
                    "The Windows Chromium input surface has no positive client width.",
                )
            })?;
        let client_height = u32::try_from(height)
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                probe_error(
                    Status::InvalidArg,
                    "The Windows Chromium input surface has no positive client height.",
                )
            })?;
        let dpi = GetDpiForWindow(surface);
        if !(48..=768).contains(&dpi) {
            return Err(probe_error(
                Status::GenericFailure,
                "Win32 returned an invalid input-surface DPI.",
            ));
        }
        let foreground_after = GetForegroundWindow();
        let active_after = GetActiveWindow();
        let focus_after = GetFocus();
        let foreground_window_preserved = foreground_before == foreground_after;
        let active_window_preserved = active_before == active_after;
        let focus_window_preserved = focus_before == focus_after;
        if !foreground_window_preserved || !active_window_preserved || !focus_window_preserved {
            return Err(probe_error(
                Status::GenericFailure,
                "The read-only Win32 input-surface probe changed focus or activation.",
            ));
        }
        Ok(WindowsChromiumInputHwndProbeReceipt {
            abi_version: WINDOWS_CHROMIUM_INPUT_PROBE_ABI_VERSION,
            surface_handle_token: native_handle_token(
                b"rion-windows-chromium-input-surface-v3",
                surface_address,
                current_process_id,
            ),
            parent_handle_token: native_handle_token(
                b"rion-windows-chromium-input-parent-v3",
                parent_address,
                current_process_id,
            ),
            process_id: current_process_id,
            ui_thread_id: surface_thread_id,
            parent_ui_thread_id: parent_thread_id,
            current_process_owned,
            exact_parent,
            child_window_style,
            popup_window_style_absent,
            no_activate_style,
            foreground_window_preserved,
            active_window_preserved,
            focus_window_preserved,
            parent_was_foreground: foreground_before == parent,
            parent_visible: IsWindowVisible(parent).as_bool(),
            surface_visible: IsWindowVisible(surface).as_bool(),
            target_was_foreground: foreground_before == surface,
            target_had_thread_focus: focus_before == surface,
            client_width,
            client_height,
            dpi,
        })
    }
}

#[cfg(not(windows))]
#[napi(js_name = "probeWindowsChromiumInputHwnd")]
pub fn probe_windows_chromium_input_hwnd(
    _surface_handle: Buffer,
    _parent_handle: Buffer,
) -> Result<WindowsChromiumInputHwndProbeReceipt> {
    Err(probe_error(
        Status::GenericFailure,
        "The Win32 Chromium input-surface probe is available only on Windows.",
    ))
}

#[cfg(windows)]
fn parse_electron_native_handle(buffer: &Buffer, field: &str) -> Result<usize> {
    if buffer.len() != size_of::<usize>() {
        return Err(probe_error(
            Status::InvalidArg,
            format!("Electron returned an invalid {field} native-handle width."),
        ));
    }
    let mut bytes = [0_u8; size_of::<usize>()];
    bytes.copy_from_slice(buffer.as_ref());
    let address = usize::from_ne_bytes(bytes);
    if address == 0 {
        return Err(probe_error(
            Status::InvalidArg,
            format!("Electron returned a null {field} native handle."),
        ));
    }
    Ok(address)
}

#[cfg(any(windows, test))]
fn native_handle_token(domain: &[u8], address: usize, process_id: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(address.to_ne_bytes());
    hasher.update(process_id.to_ne_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(any(windows, test))]
fn windows_runtime_parent_identity(
    address: usize,
    process_id: u32,
    owner_thread_id: u32,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"rion-windows-runtime-parent-foreground-v1");
    hasher.update(address.to_ne_bytes());
    hasher.update(process_id.to_ne_bytes());
    hasher.update(owner_thread_id.to_ne_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(any(windows, test))]
fn classify_windows_runtime_foreground(
    facts: WindowsRuntimeForegroundFacts,
) -> std::result::Result<WindowsRuntimeForegroundState, WindowsRuntimeForegroundFactError> {
    if facts.parent_address == 0 || !facts.valid_before || !facts.valid_after {
        return Err(WindowsRuntimeForegroundFactError::InvalidParent);
    }
    if facts.owner_thread_id_before == 0 || facts.owner_thread_id_after == 0 {
        return Err(WindowsRuntimeForegroundFactError::OwnershipUnavailable);
    }
    if facts.owner_process_id_before != facts.current_process_id
        || facts.owner_process_id_after != facts.current_process_id
    {
        return Err(WindowsRuntimeForegroundFactError::ForeignOwner);
    }
    if facts.owner_thread_id_before != facts.owner_thread_id_after
        || facts.owner_process_id_before != facts.owner_process_id_after
    {
        return Err(WindowsRuntimeForegroundFactError::OwnerChanged);
    }
    if facts.foreground_before != facts.foreground_after
        || facts.active_before != facts.active_after
        || facts.focus_before != facts.focus_after
        || facts.visible_before != facts.visible_after
        || facts.minimized_before != facts.minimized_after
    {
        return Err(WindowsRuntimeForegroundFactError::ObservationChanged);
    }
    Ok(WindowsRuntimeForegroundState {
        owner_thread_id: facts.owner_thread_id_before,
        parent_was_foreground: facts.foreground_before == facts.parent_address,
        parent_visible: facts.visible_before,
        parent_minimized: facts.minimized_before,
    })
}

#[cfg(windows)]
fn windows_runtime_foreground_error(error: WindowsRuntimeForegroundFactError) -> Error {
    let (status, message) = match error {
        WindowsRuntimeForegroundFactError::InvalidParent => (
            Status::InvalidArg,
            "Electron supplied a stale or invalid Windows runtime-parent handle.",
        ),
        WindowsRuntimeForegroundFactError::OwnershipUnavailable => (
            Status::GenericFailure,
            "Win32 could not read the exact runtime-parent ownership.",
        ),
        WindowsRuntimeForegroundFactError::ForeignOwner => (
            Status::InvalidArg,
            "The Windows runtime parent must be owned by the current Electron process.",
        ),
        WindowsRuntimeForegroundFactError::OwnerChanged => (
            Status::GenericFailure,
            "The exact Windows runtime-parent owner changed during foreground readback.",
        ),
        WindowsRuntimeForegroundFactError::ObservationChanged => (
            Status::GenericFailure,
            "The Windows runtime-parent focus or presentation changed during foreground readback.",
        ),
    };
    probe_error(status, message)
}

fn probe_error(status: Status, message: impl Into<String>) -> Error {
    Error::new(status, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn foreground_facts() -> WindowsRuntimeForegroundFacts {
        WindowsRuntimeForegroundFacts {
            parent_address: 42,
            current_process_id: 7,
            owner_process_id_before: 7,
            owner_process_id_after: 7,
            owner_thread_id_before: 9,
            owner_thread_id_after: 9,
            valid_before: true,
            valid_after: true,
            foreground_before: 42,
            foreground_after: 42,
            active_before: 42,
            active_after: 42,
            focus_before: 11,
            focus_after: 11,
            visible_before: true,
            visible_after: true,
            minimized_before: false,
            minimized_after: false,
        }
    }

    #[test]
    fn opaque_tokens_are_domain_and_owner_bound() {
        let surface = native_handle_token(b"surface", 42, 7);
        assert_eq!(surface.len(), 64);
        assert_eq!(surface, native_handle_token(b"surface", 42, 7));
        assert_ne!(surface, native_handle_token(b"parent", 42, 7));
        assert_ne!(surface, native_handle_token(b"surface", 43, 7));
        assert_ne!(surface, native_handle_token(b"surface", 42, 8));
    }

    #[test]
    fn runtime_parent_identity_is_handle_process_and_thread_bound() {
        let identity = windows_runtime_parent_identity(42, 7, 9);
        assert_eq!(identity.len(), 64);
        assert_eq!(identity, windows_runtime_parent_identity(42, 7, 9));
        assert_ne!(identity, windows_runtime_parent_identity(43, 7, 9));
        assert_ne!(identity, windows_runtime_parent_identity(42, 8, 9));
        assert_ne!(identity, windows_runtime_parent_identity(42, 7, 10));
    }

    #[test]
    fn exact_stable_parent_classifies_foreground_visibility_and_minimized_state() {
        let state = classify_windows_runtime_foreground(foreground_facts()).unwrap();
        assert_eq!(state.owner_thread_id, 9);
        assert!(state.parent_was_foreground);
        assert!(state.parent_visible);
        assert!(!state.parent_minimized);

        let mut background_minimized = foreground_facts();
        background_minimized.foreground_before = 100;
        background_minimized.foreground_after = 100;
        background_minimized.visible_before = false;
        background_minimized.visible_after = false;
        background_minimized.minimized_before = true;
        background_minimized.minimized_after = true;
        let state = classify_windows_runtime_foreground(background_minimized).unwrap();
        assert!(!state.parent_was_foreground);
        assert!(!state.parent_visible);
        assert!(state.parent_minimized);
    }

    #[test]
    fn runtime_parent_readback_fails_closed_for_stale_or_foreign_ownership() {
        let mut facts = foreground_facts();
        facts.valid_after = false;
        assert_eq!(
            classify_windows_runtime_foreground(facts),
            Err(WindowsRuntimeForegroundFactError::InvalidParent)
        );

        let mut facts = foreground_facts();
        facts.owner_process_id_after = 8;
        assert_eq!(
            classify_windows_runtime_foreground(facts),
            Err(WindowsRuntimeForegroundFactError::ForeignOwner)
        );

        let mut facts = foreground_facts();
        facts.owner_thread_id_after = 10;
        assert_eq!(
            classify_windows_runtime_foreground(facts),
            Err(WindowsRuntimeForegroundFactError::OwnerChanged)
        );
    }

    #[test]
    fn runtime_parent_readback_rejects_mixed_focus_or_presentation_observations() {
        let mutations: [fn(&mut WindowsRuntimeForegroundFacts); 5] = [
            |facts: &mut WindowsRuntimeForegroundFacts| facts.foreground_after = 100,
            |facts: &mut WindowsRuntimeForegroundFacts| facts.active_after = 100,
            |facts: &mut WindowsRuntimeForegroundFacts| facts.focus_after = 100,
            |facts: &mut WindowsRuntimeForegroundFacts| facts.visible_after = false,
            |facts: &mut WindowsRuntimeForegroundFacts| facts.minimized_after = true,
        ];
        for mutate in mutations {
            let mut facts = foreground_facts();
            mutate(&mut facts);
            assert_eq!(
                classify_windows_runtime_foreground(facts),
                Err(WindowsRuntimeForegroundFactError::ObservationChanged)
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn runtime_parent_foreground_readback_fails_closed_off_windows() {
        let error =
            read_windows_runtime_foreground(Buffer::from(vec![0_u8; std::mem::size_of::<usize>()]))
                .err()
                .expect("the Win32-only readback must reject a non-Windows host");
        assert_eq!(error.status, Status::GenericFailure);
        assert!(error.reason.contains("only on Windows"));
    }

    #[test]
    fn probe_abi_is_stable_without_advertising_platform_capability() {
        assert_eq!(windows_chromium_input_probe_abi_version(), 3);
    }
}
