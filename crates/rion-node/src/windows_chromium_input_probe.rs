use crate::windows_native_handle::probe_error;
#[cfg(windows)]
use crate::windows_native_handle::{parse_electron_native_handle, windows_focus_identity};
use napi::{Status, bindgen_prelude::*};
use napi_derive::napi;
#[cfg(any(windows, test))]
use sha2::{Digest, Sha256};

const WINDOWS_CHROMIUM_INPUT_PROBE_ABI_VERSION: u32 = 6;

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
    pub focus_identity: String,
    pub parent_was_foreground: bool,
    pub parent_visible: bool,
    pub surface_visible: bool,
    pub target_was_foreground: bool,
    pub target_had_thread_focus: bool,
    pub client_width: u32,
    pub client_height: u32,
    pub dpi: u32,
}

#[napi(js_name = "windowsChromiumInputProbeAbiVersion")]
pub fn windows_chromium_input_probe_abi_version() -> u32 {
    WINDOWS_CHROMIUM_INPUT_PROBE_ABI_VERSION
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
                b"rion-windows-chromium-input-surface-v5",
                surface_address,
                current_process_id,
            ),
            parent_handle_token: native_handle_token(
                b"rion-windows-chromium-input-parent-v5",
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
            focus_identity: windows_focus_identity(
                current_process_id,
                surface_thread_id,
                foreground_before.0 as usize,
                active_before.0 as usize,
                focus_before.0 as usize,
            ),
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

#[cfg(any(windows, test))]
fn native_handle_token(domain: &[u8], address: usize, process_id: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(address.to_ne_bytes());
    hasher.update(process_id.to_ne_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn probe_abi_is_stable_without_advertising_platform_capability() {
        assert_eq!(windows_chromium_input_probe_abi_version(), 6);
    }
}
