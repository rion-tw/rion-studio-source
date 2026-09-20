use crate::RuntimeTabsControllerError;
use std::{
    ffi::{CStr, c_void},
    ptr::NonNull,
};

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn rion_runtime_tabs_control_row_contains(controller: *mut c_void, x: f64, y: f64) -> bool;
    fn rion_runtime_tabs_drag_anchor(
        controller: *mut c_void,
        tab: *const std::ffi::c_char,
        ratio_x: f64,
        ratio_y: f64,
        x: *mut f64,
        y: *mut f64,
    ) -> bool;
}

/// Reads the live native control row, including fullscreen rehosting.
/// # Safety
/// The controller must be live on AppKit main for the entire call.
pub unsafe fn runtime_tab_drag_contains(
    controller: NonNull<c_void>,
    x: f64,
    y: f64,
) -> Result<bool, RuntimeTabsControllerError> {
    #[cfg(target_os = "macos")]
    {
        crate::require_main_thread()?;
        if !x.is_finite() || !y.is_finite() {
            return Err(RuntimeTabsControllerError::InvalidLayout);
        }
        // SAFETY: the caller retains the exact live main-thread controller.
        Ok(unsafe { rion_runtime_tabs_control_row_contains(controller.as_ptr(), x, y) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (controller, x, y);
        Err(RuntimeTabsControllerError::InvalidLayout)
    }
}

/// Reads the original pointer anchor against the current native tab layout.
/// # Safety
/// The controller and tab identifier must be live on AppKit main.
pub unsafe fn runtime_tab_drag_anchor(
    controller: NonNull<c_void>,
    tab: &CStr,
    ratio_x: f64,
    ratio_y: f64,
) -> Result<(f64, f64), RuntimeTabsControllerError> {
    #[cfg(target_os = "macos")]
    {
        crate::require_main_thread()?;
        if !ratio_x.is_finite()
            || !ratio_y.is_finite()
            || !(0.0..=1.0).contains(&ratio_x)
            || !(0.0..=1.0).contains(&ratio_y)
        {
            return Err(RuntimeTabsControllerError::InvalidLayout);
        }
        let (mut x, mut y) = (0.0, 0.0);
        // SAFETY: the caller retains the controller and C string; outputs are local.
        let valid = unsafe {
            rion_runtime_tabs_drag_anchor(
                controller.as_ptr(),
                tab.as_ptr(),
                ratio_x,
                ratio_y,
                &raw mut x,
                &raw mut y,
            )
        };
        if !valid || !x.is_finite() || !y.is_finite() {
            return Err(RuntimeTabsControllerError::InvalidLayout);
        }
        Ok((x, y))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (controller, tab, ratio_x, ratio_y);
        Err(RuntimeTabsControllerError::InvalidLayout)
    }
}
