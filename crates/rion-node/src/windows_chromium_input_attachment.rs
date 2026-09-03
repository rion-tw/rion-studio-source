use napi::{Status, bindgen_prelude::*};
use napi_derive::napi;

use crate::windows_chromium_input_probe::{WindowsChromiumInputHwndProbeReceipt, probe_error};
#[cfg(windows)]
use crate::windows_chromium_input_probe::{
    parse_electron_native_handle, probe_windows_chromium_input_hwnd,
};

#[cfg(any(windows, test))]
fn attached_style(style: u32) -> u32 {
    (style | 0x4000_0000) & !0x8000_0000
}

#[cfg(any(windows, test))]
fn attached_extended_style(style: u32) -> u32 {
    style | 0x0800_0000
}

/// Converts Electron's Windows surface into the exact no-activate
/// `WS_CHILD` required by the managed Chromium input lane.
///
/// Electron supplies both public BaseWindow HWNDs. This function never
/// enumerates or guesses a Chromium HWND, and verifies that the mutation keeps
/// the same process, UI thread, foreground, active window, and focus owner.
#[cfg(windows)]
#[napi(js_name = "attachWindowsChromiumInputHwnd")]
pub fn attach_windows_chromium_input_hwnd(
    surface_handle: Buffer,
    parent_handle: Buffer,
) -> Result<WindowsChromiumInputHwndProbeReceipt> {
    use windows::Win32::{
        Foundation::{GetLastError, HWND, RECT, SetLastError, WIN32_ERROR},
        System::Threading::{GetCurrentProcessId, GetCurrentThreadId},
        UI::{
            Input::KeyboardAndMouse::{GetActiveWindow, GetFocus},
            WindowsAndMessaging::{
                GWL_EXSTYLE, GWL_STYLE, GWLP_HWNDPARENT, GetClientRect, GetForegroundWindow,
                GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, SWP_FRAMECHANGED,
                SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSENDCHANGING, SWP_NOZORDER,
                SetWindowLongPtrW, SetWindowPos,
            },
        },
    };

    fn set_window_long(
        window: HWND,
        index: windows::Win32::UI::WindowsAndMessaging::WINDOW_LONG_PTR_INDEX,
        value: isize,
    ) -> Result<()> {
        // SAFETY: the caller has already proven that `window` is a live HWND
        // owned by this process and UI thread. Last-error disambiguates a
        // valid zero previous value from a failed SetWindowLongPtrW call.
        unsafe {
            SetLastError(WIN32_ERROR(0));
            let previous = SetWindowLongPtrW(window, index, value);
            let error = GetLastError();
            if previous == 0 && error != WIN32_ERROR(0) {
                return Err(probe_error(
                    Status::GenericFailure,
                    "Win32 rejected the exact Chromium input-surface style mutation.",
                ));
            }
        }
        Ok(())
    }

    fn set_parent(window: HWND, parent: Option<HWND>) -> Result<()> {
        // The high-level `windows` binding treats a null previous parent as an
        // error. User32 documents that null is also the successful result when
        // a top-level Electron surface had no prior native owner, so call the
        // raw ABI and disambiguate with last-error.
        unsafe {
            SetLastError(WIN32_ERROR(0));
            let previous = windows_sys::Win32::UI::WindowsAndMessaging::SetParent(
                window.0,
                parent.map_or(core::ptr::null_mut(), |value| value.0),
            );
            let error = GetLastError();
            if previous.is_null() && error != WIN32_ERROR(0) {
                return Err(probe_error(
                    Status::GenericFailure,
                    "Win32 rejected the exact Chromium input-surface parent attachment.",
                ));
            }
            Ok(())
        }
    }

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

    // SAFETY: both opaque Electron handles are validated with User32 before
    // mutation. Every write is confined to the exact same-process, same-thread
    // surface supplied by the caller, followed by complete native readback.
    unsafe {
        if !IsWindow(Some(surface)).as_bool() || !IsWindow(Some(parent)).as_bool() {
            return Err(probe_error(
                Status::InvalidArg,
                "Electron supplied a stale or invalid Windows native handle.",
            ));
        }
        let current_process_id = GetCurrentProcessId();
        let current_thread_id = GetCurrentThreadId();
        let mut surface_process_id = 0;
        let surface_thread_id =
            GetWindowThreadProcessId(surface, Some(&raw mut surface_process_id));
        let mut parent_process_id = 0;
        let parent_thread_id = GetWindowThreadProcessId(parent, Some(&raw mut parent_process_id));
        if surface_thread_id == 0
            || parent_thread_id == 0
            || surface_process_id != current_process_id
            || parent_process_id != current_process_id
            || surface_thread_id != parent_thread_id
            || surface_thread_id != current_thread_id
        {
            return Err(probe_error(
                Status::InvalidArg,
                "The Windows Chromium input child and parent must share the calling Electron UI owner.",
            ));
        }
        let original_parent = {
            let raw = GetWindowLongPtrW(surface, GWLP_HWNDPARENT);
            (raw != 0).then_some(HWND(raw as *mut core::ffi::c_void))
        };
        let foreground_before = GetForegroundWindow();
        let active_before = GetActiveWindow();
        let focus_before = GetFocus();
        let original_style = GetWindowLongPtrW(surface, GWL_STYLE);
        let original_extended_style = GetWindowLongPtrW(surface, GWL_EXSTYLE);
        let mut parent_client = RECT::default();
        GetClientRect(parent, &raw mut parent_client).map_err(|_| {
            probe_error(
                Status::GenericFailure,
                "Win32 could not read the exact runtime-parent client bounds.",
            )
        })?;
        let width = parent_client
            .right
            .checked_sub(parent_client.left)
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                probe_error(
                    Status::InvalidArg,
                    "The exact runtime parent has no positive client width.",
                )
            })?;
        let height = parent_client
            .bottom
            .checked_sub(parent_client.top)
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                probe_error(
                    Status::InvalidArg,
                    "The exact runtime parent has no positive client height.",
                )
            })?;
        let desired_style = attached_style(original_style as u32) as isize;
        let desired_extended_style =
            attached_extended_style(original_extended_style as u32) as isize;

        let attach_result = (|| -> Result<()> {
            set_window_long(surface, GWL_STYLE, desired_style)?;
            set_window_long(surface, GWL_EXSTYLE, desired_extended_style)?;
            set_parent(surface, Some(parent))?;
            SetWindowPos(
                surface,
                None,
                0,
                0,
                width,
                height,
                SWP_FRAMECHANGED
                    | SWP_NOACTIVATE
                    | SWP_NOOWNERZORDER
                    | SWP_NOSENDCHANGING
                    | SWP_NOZORDER,
            )
            .map_err(|_| {
                probe_error(
                    Status::GenericFailure,
                    "Win32 rejected the exact Chromium input-surface client bounds.",
                )
            })?;
            if GetForegroundWindow() != foreground_before
                || GetActiveWindow() != active_before
                || GetFocus() != focus_before
            {
                return Err(probe_error(
                    Status::GenericFailure,
                    "The Windows Chromium input attachment changed focus or activation.",
                ));
            }
            Ok(())
        })();
        if let Err(error) = attach_result {
            let _ = set_parent(surface, original_parent);
            let _ = set_window_long(surface, GWL_STYLE, original_style);
            let _ = set_window_long(surface, GWL_EXSTYLE, original_extended_style);
            return Err(error);
        }
    }

    probe_windows_chromium_input_hwnd(surface_handle, parent_handle)
}

#[cfg(not(windows))]
#[napi(js_name = "attachWindowsChromiumInputHwnd")]
pub fn attach_windows_chromium_input_hwnd(
    _surface_handle: Buffer,
    _parent_handle: Buffer,
) -> Result<WindowsChromiumInputHwndProbeReceipt> {
    Err(probe_error(
        Status::GenericFailure,
        "The Win32 Chromium input-surface attachment is available only on Windows.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_replaces_popup_with_child_without_losing_other_styles() {
        let style = 0x8000_0000 | 0x1000_0000 | 0x0004_0000;
        assert_eq!(attached_style(style), 0x5004_0000);
        assert_eq!(attached_extended_style(0x0000_0080), 0x0800_0080);
    }
}
