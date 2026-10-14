//! One synchronous, current-UI-thread activation veto for one exact HWND.
use crate::windows_native_handle::probe_error;
use napi::{Result, Status};
use std::cell::Cell;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::Threading::{GetCurrentProcessId, GetCurrentThreadId},
    UI::WindowsAndMessaging::{
        CallNextHookEx, GetWindowThreadProcessId, HCBT_ACTIVATE, HHOOK, IsWindow,
        SetWindowsHookExW, UnhookWindowsHookEx, WH_CBT,
    },
};

thread_local! {
    static TARGET: Cell<Option<usize>> = const { Cell::new(None) };
}

fn veto_activation(code: i32, target: Option<usize>, requested: usize) -> bool {
    code == HCBT_ACTIVATE as i32 && target == Some(requested)
}

unsafe extern "system" fn activation(code: i32, requested: WPARAM, data: LPARAM) -> LRESULT {
    if TARGET.with(|target| veto_activation(code, target.get(), requested.0)) {
        // Microsoft CBTProc: nonzero prevents this exact activation only.
        return LRESULT(1);
    }
    // SAFETY: every other window/code, including all negative codes and input
    // notifications, remains in the unchanged current UI-thread hook chain.
    unsafe { CallNextHookEx(None, code, requested, data) }
}

pub(super) struct NativeActivationGuard {
    target: usize,
    hook: Option<HHOOK>,
}

impl NativeActivationGuard {
    pub(super) fn begin(parent: HWND) -> Result<Self> {
        let target = parent.0 as usize;
        let mut guard = Self { target, hook: None };
        let mut owner_process = 0;
        // SAFETY: read-only validation of the supplied parent; the hook is
        // installed only on its exact current-process/UI thread, never thread 0.
        let thread = unsafe { GetCurrentThreadId() };
        let current = unsafe {
            IsWindow(Some(parent)).as_bool()
                && GetWindowThreadProcessId(parent, Some(&raw mut owner_process)) == thread
                && owner_process == GetCurrentProcessId()
        };
        if !current || thread == 0 {
            return Err(probe_error(
                Status::InvalidArg,
                "Activation veto requires the exact current UI-thread runtime parent.",
            ));
        }
        let available = TARGET.with(|value| {
            if value.get().is_some() {
                return false;
            }
            value.set(Some(target));
            true
        });
        if !available {
            return Err(probe_error(
                Status::GenericFailure,
                "Another exact-parent synchronous activation scope is active.",
            ));
        }
        // SAFETY: callback is retained by this loaded addon; the nonzero thread
        // ID binds only the calling Electron UI thread. No input hook is used.
        match unsafe { SetWindowsHookExW(WH_CBT, Some(activation), None, thread) } {
            Ok(hook) => guard.hook = Some(hook),
            Err(error) => {
                TARGET.with(|value| value.set(None));
                return Err(probe_error(Status::GenericFailure, error.to_string()));
            }
        }
        Ok(guard)
    }

    pub(super) fn release(&mut self) -> Result<()> {
        let Some(hook) = self.hook.take() else {
            return Ok(());
        };
        // Clear the active target first. Even failed unhook cannot leave an
        // activation veto behind; the remaining callback only passes through.
        TARGET.with(|value| {
            if value.get() == Some(self.target) {
                value.set(None);
            }
        });
        // SAFETY: this handle belongs to exactly this current-thread scope.
        unsafe { UnhookWindowsHookEx(hook) }
            .map_err(|error| probe_error(Status::GenericFailure, error.to_string()))
    }
}

impl Drop for NativeActivationGuard {
    fn drop(&mut self) {
        // An error or unwinding still retires the exact target and native hook.
        let _ = self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn veto_is_limited_to_exact_target_activation_and_passes_all_other_codes() {
        assert!(veto_activation(HCBT_ACTIVATE as i32, Some(42), 42));
        assert!(!veto_activation(HCBT_ACTIVATE as i32, Some(42), 43));
        assert!(!veto_activation(HCBT_ACTIVATE as i32, None, 42));
        for code in [-1, 0, 1, 2, 3, 4, 6, 7, 8, 9] {
            assert!(!veto_activation(code, Some(42), 42));
        }
    }
}
