//! Read-only native foreground evidence retained by the direct Chromium View runtime.
use crate::windows_native_handle::probe_error;
#[cfg(windows)]
use crate::windows_native_handle::{parse_electron_native_handle, windows_focus_identity};
use napi::{Status, bindgen_prelude::*};
use napi_derive::napi;
#[cfg(any(windows, test))]
use sha2::{Digest, Sha256};

#[napi(object)]
pub struct WindowsRuntimeForegroundReadback {
    pub parent_identity: String,
    pub focus_identity: String,
    pub parent_was_foreground: bool,
    pub parent_visible: bool,
    pub parent_minimized: bool,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowsRuntimeForegroundFacts {
    parent_address: usize,
    current_process_id: u32,
    current_thread_id: u32,
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
    ForeignThread,
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
        System::Threading::{GetCurrentProcessId, GetCurrentThreadId},
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
        let current_thread_id = GetCurrentThreadId();
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
            current_thread_id,
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
            focus_identity: windows_focus_identity(
                current_process_id,
                state.owner_thread_id,
                foreground_before,
                active_before,
                focus_before,
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
    if facts.current_thread_id != facts.owner_thread_id_before {
        return Err(WindowsRuntimeForegroundFactError::ForeignThread);
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
        WindowsRuntimeForegroundFactError::ForeignThread => (
            Status::InvalidArg,
            "The Windows runtime-parent focus must be observed on its owning Electron UI thread.",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn foreground_facts() -> WindowsRuntimeForegroundFacts {
        WindowsRuntimeForegroundFacts {
            parent_address: 42,
            current_process_id: 7,
            current_thread_id: 9,
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
    fn parent_focus_readback_rejects_a_foreign_calling_thread() {
        let mut facts = foreground_facts();
        facts.current_thread_id = 10;
        assert_eq!(
            classify_windows_runtime_foreground(facts),
            Err(WindowsRuntimeForegroundFactError::ForeignThread)
        );
    }
}
