//! Exact-parent synchronous native presentation; never requests focus recovery.
use crate::windows_native_handle::probe_error;
use crate::windows_runtime_foreground::WindowsRuntimeForegroundReadback;
#[cfg(windows)]
use crate::windows_runtime_foreground::read_windows_runtime_foreground;
use napi::{Status, bindgen_prelude::*};
use napi_derive::napi;

#[cfg(windows)]
mod activation_guard;
#[cfg(windows)]
use activation_guard::NativeActivationGuard;

#[cfg(any(windows, test))]
fn require_background_parent(
    expected_parent_identity: &str,
    before: &WindowsRuntimeForegroundReadback,
) -> Result<()> {
    if expected_parent_identity != before.parent_identity
        || before.parent_was_foreground
        || !before.parent_visible
        || before.parent_minimized
    {
        return Err(probe_error(
            Status::InvalidArg,
            "Inactive maximize requires the exact visible background runtime parent.",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn require_inactive_acknowledgement(
    before: &WindowsRuntimeForegroundReadback,
    after: &WindowsRuntimeForegroundReadback,
    maximized: bool,
) -> Result<()> {
    if before.parent_identity != after.parent_identity
        || before.focus_identity != after.focus_identity
        || after.parent_was_foreground
        || !after.parent_visible
        || after.parent_minimized
        || !maximized
    {
        return Err(probe_error(
            Status::GenericFailure,
            "The native inactive maximize did not preserve its exact parent and focus acknowledgement.",
        ));
    }
    Ok(())
}

/// A bounded native submission: exact HWND ownership and UI thread are
/// checked by the foreground readback before native mutation. The caller must
/// additionally own the current Core generation/revision and arm Electron's
/// exact maximize/layout event receipt before invoking this synchronous lane.
/// An unknown native outcome is reported without reactivating another window.
#[cfg(windows)]
#[napi(js_name = "maximizeWindowsRuntimeParentInactive")]
pub fn maximize_windows_runtime_parent_inactive(
    parent_handle: Buffer,
    expected_parent_identity: String,
) -> Result<WindowsRuntimeForegroundReadback> {
    use crate::windows_native_handle::parse_electron_native_handle;
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            GetWindowPlacement, IsZoomed, SW_SHOWMAXIMIZED, SetWindowPlacement, WINDOWPLACEMENT,
            WPF_ASYNCWINDOWPLACEMENT,
        },
    };

    let before = read_windows_runtime_foreground(Buffer::from(parent_handle.as_ref().to_vec()))?;
    require_background_parent(&expected_parent_identity, &before)?;
    let parent = HWND(
        parse_electron_native_handle(&parent_handle, "inactive maximize parent")?
            as *mut core::ffi::c_void,
    );
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..WINDOWPLACEMENT::default()
    };
    // SAFETY: the exact supplied HWND is current-process/UI-thread-owned. The
    // local placement struct is retained throughout these synchronous calls;
    // existing normal/min/max rectangles are copied without geometry invention.
    unsafe { GetWindowPlacement(parent, &raw mut placement) }
        .map_err(|error| probe_error(Status::GenericFailure, error.to_string()))?;
    placement.flags &= !WPF_ASYNCWINDOWPLACEMENT;
    placement.showCmd = SW_SHOWMAXIMIZED.0 as u32;
    // The exact-parent activation veto covers this one synchronous submission,
    // never retained across JS/event waits or another window's activation.
    let mut guard = NativeActivationGuard::begin(parent)?;
    let submitted = (|| {
        let guarded =
            read_windows_runtime_foreground(Buffer::from(parent_handle.as_ref().to_vec()))?;
        require_background_parent(&expected_parent_identity, &guarded)?;
        if before.focus_identity != guarded.focus_identity {
            return Err(probe_error(
                Status::GenericFailure,
                "The native activation guard changed focus before maximize.",
            ));
        }
        // SAFETY: same exact parent and stack-owned placement; asynchronous
        // execution is forbidden, and no foreground/focus API is called.
        unsafe { SetWindowPlacement(parent, &raw const placement) }
            .map_err(|error| probe_error(Status::GenericFailure, error.to_string()))
    })();
    guard.release()?;
    submitted?;
    let after = read_windows_runtime_foreground(parent_handle)?;
    // SAFETY: the preceding readback revalidated the same process/UI owner.
    let maximized = unsafe { IsZoomed(parent) }.as_bool();
    require_inactive_acknowledgement(&before, &after, maximized)?;
    let mut acknowledged = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..WINDOWPLACEMENT::default()
    };
    // SAFETY: read-only exact-parent placement after owner/focus validation.
    unsafe { GetWindowPlacement(parent, &raw mut acknowledged) }
        .map_err(|error| probe_error(Status::GenericFailure, error.to_string()))?;
    if placement.rcNormalPosition != acknowledged.rcNormalPosition {
        return Err(probe_error(
            Status::GenericFailure,
            "Inactive maximize changed the exact parent's retained normal bounds.",
        ));
    }
    Ok(after)
}

#[cfg(not(windows))]
#[napi(js_name = "maximizeWindowsRuntimeParentInactive")]
pub fn maximize_windows_runtime_parent_inactive(
    _parent_handle: Buffer,
    _expected_parent_identity: String,
) -> Result<WindowsRuntimeForegroundReadback> {
    Err(probe_error(
        Status::GenericFailure,
        "Inactive Windows runtime-parent maximize is available only on Windows.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn background() -> WindowsRuntimeForegroundReadback {
        WindowsRuntimeForegroundReadback {
            parent_identity: "a".repeat(64),
            focus_identity: "b".repeat(64),
            parent_was_foreground: false,
            parent_visible: true,
            parent_minimized: false,
        }
    }

    #[test]
    fn inactive_submission_requires_exact_visible_background_parent() {
        let baseline = background();
        require_background_parent(&baseline.parent_identity, &baseline).unwrap();
        for changed in 0..4 {
            let mut value = background();
            match changed {
                0 => value.parent_identity = "c".repeat(64),
                1 => value.parent_was_foreground = true,
                2 => value.parent_visible = false,
                _ => value.parent_minimized = true,
            }
            assert!(require_background_parent(&baseline.parent_identity, &value).is_err());
        }
    }

    #[test]
    fn acknowledgement_refuses_focus_change_or_missing_real_native_mode() {
        let before = background();
        require_inactive_acknowledgement(&before, &background(), true).unwrap();
        assert!(require_inactive_acknowledgement(&before, &background(), false).is_err());
        for changed in 0..5 {
            let mut after = background();
            match changed {
                0 => after.parent_identity = "c".repeat(64),
                1 => after.focus_identity = "c".repeat(64),
                2 => after.parent_was_foreground = true,
                3 => after.parent_visible = false,
                _ => after.parent_minimized = true,
            }
            assert!(require_inactive_acknowledgement(&before, &after, true).is_err());
        }
    }
}
