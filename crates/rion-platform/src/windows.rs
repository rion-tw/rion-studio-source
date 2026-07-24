//! Native Windows window discovery and visible-frame alignment. This keeps the
//! behavior of the former standalone C++ helper inside the Rust platform crate.

use std::{
    mem::size_of,
    thread,
    time::{Duration, Instant},
};

use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DWMWINDOWATTRIBUTE, DwmFlush,
    DwmGetWindowAttribute, DwmSetWindowAttribute,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GetClassNameW, GetWindow, GetWindowRect, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, IsZoomed, SW_SHOWNOACTIVATE, SWP_NOACTIVATE,
    SWP_NOOWNERZORDER, SWP_NOZORDER, SetWindowPos, ShowWindowAsync,
};
use windows::core::BOOL;

use crate::{
    PixelBounds, PlatformError, WindowCandidateMetadata, WindowFrameBackend,
    align_visible_frame_with_backend, candidate_matches_process, select_best_candidate,
};

const WINDOW_WAIT_TIMEOUT: Duration = Duration::from_millis(1_500);
const WINDOW_POLL_INTERVAL: Duration = Duration::from_millis(50);
const CHROME_WIDGET_PREFIX: &str = "Chrome_WidgetWin_";
const WINDOW_CORNER_PREFERENCE_ATTRIBUTE: DWMWINDOWATTRIBUTE = DWMWINDOWATTRIBUTE(33);
const BORDER_COLOR_ATTRIBUTE: DWMWINDOWATTRIBUTE = DWMWINDOWATTRIBUTE(34);
const DO_NOT_ROUND_WINDOW_CORNERS: u32 = 1;
const SUPPRESS_WINDOW_BORDER_COLOR: u32 = 0xffff_fffe;

struct WindowCandidate {
    hwnd: HWND,
    metadata: WindowCandidateMetadata,
}

struct EnumerationContext {
    process_id: u32,
    candidates: *mut Vec<WindowCandidate>,
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let context = unsafe { &mut *(lparam.0 as *mut EnumerationContext) };
    if !unsafe { IsWindowVisible(hwnd).as_bool() } || unsafe { IsIconic(hwnd).as_bool() } {
        return BOOL(1);
    }
    let mut process_id = 0_u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    if !candidate_matches_process(context.process_id, process_id) {
        return BOOL(1);
    }
    let mut cloaked = 0_u32;
    if unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&raw mut cloaked).cast(),
            size_of::<u32>() as u32,
        )
    }
    .is_err()
        || cloaked != 0
    {
        return BOOL(1);
    }
    let Ok(visible) = read_visible_bounds(hwnd) else {
        return BOOL(1);
    };
    let ownerless = unsafe { GetWindow(hwnd, GW_OWNER) }
        .ok()
        .is_none_or(|owner| owner.0.is_null());
    let candidate = WindowCandidate {
        hwnd,
        metadata: WindowCandidateMetadata {
            visible,
            is_chrome_widget: is_chrome_widget(hwnd),
            is_ownerless: ownerless,
        },
    };
    unsafe { &mut *context.candidates }.push(candidate);
    BOOL(1)
}

pub fn align_visible_frame(
    process_id: u32,
    target: PixelBounds,
) -> Result<PixelBounds, PlatformError> {
    let target = crate::validate_alignment_request(process_id, target)?;

    let hwnd = find_window(process_id, target)?;
    restore_window(hwnd)?;
    configure_seamless_frame(hwnd);
    let mut backend = NativeWindowFrameBackend { hwnd };
    Ok(align_visible_frame_with_backend(process_id, target, &mut backend)?.visible)
}

struct NativeWindowFrameBackend {
    hwnd: HWND,
}

impl WindowFrameBackend for NativeWindowFrameBackend {
    fn read_visible_bounds(&mut self) -> Result<PixelBounds, PlatformError> {
        read_visible_bounds(self.hwnd)
    }

    fn read_outer_bounds(&mut self) -> Result<PixelBounds, PlatformError> {
        read_outer_bounds(self.hwnd)
    }

    fn set_outer_bounds(&mut self, bounds: PixelBounds) -> Result<(), PlatformError> {
        unsafe {
            SetWindowPos(
                self.hwnd,
                None,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
            )
        }
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
        unsafe { DwmFlush() }
            .map_err(|error| PlatformError::Operation(format!("DWM flush failed: {error}")))
    }

    fn read_dpi(&mut self) -> Result<u32, PlatformError> {
        let dpi = unsafe { GetDpiForWindow(self.hwnd) };
        if dpi == 0 {
            Err(PlatformError::Operation(
                "window DPI must be positive".to_owned(),
            ))
        } else {
            Ok(dpi)
        }
    }
}

fn find_window(process_id: u32, target: PixelBounds) -> Result<HWND, PlatformError> {
    let deadline = Instant::now() + WINDOW_WAIT_TIMEOUT;
    loop {
        let mut candidates = Vec::new();
        let mut context = EnumerationContext {
            process_id,
            candidates: &raw mut candidates,
        };
        unsafe {
            EnumWindows(
                Some(collect_window),
                LPARAM((&raw mut context).cast::<()>() as isize),
            )
        }
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
        let metadata = candidates
            .iter()
            .map(|candidate| candidate.metadata)
            .collect::<Vec<_>>();
        let selection_error = match select_best_candidate(&metadata, target) {
            Ok(Some(index)) => return Ok(candidates[index].hwnd),
            Ok(None) => None,
            Err(error) => Some(error),
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(selection_error.unwrap_or_else(|| {
                PlatformError::Operation(
                    "no eligible top-level window was found for the process".to_owned(),
                )
            }));
        }
        thread::sleep(WINDOW_POLL_INTERVAL.min(remaining));
    }
}

fn restore_window(hwnd: HWND) -> Result<(), PlatformError> {
    if !unsafe { IsZoomed(hwnd).as_bool() || IsIconic(hwnd).as_bool() } {
        return Ok(());
    }
    if !unsafe { ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE).as_bool() } {
        return Err(PlatformError::Operation(
            "failed to request a non-activating normal window state".to_owned(),
        ));
    }
    for _ in 0..30 {
        thread::sleep(WINDOW_POLL_INTERVAL);
        if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
            return Err(PlatformError::Operation(
                "external Chrome window disappeared while restoring".to_owned(),
            ));
        }
        if !unsafe { IsZoomed(hwnd).as_bool() || IsIconic(hwnd).as_bool() } {
            return Ok(());
        }
    }
    Err(PlatformError::Operation(
        "external Chrome window restore timed out".to_owned(),
    ))
}

fn configure_seamless_frame(hwnd: HWND) {
    let corner_preference = DO_NOT_ROUND_WINDOW_CORNERS;
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            WINDOW_CORNER_PREFERENCE_ATTRIBUTE,
            (&raw const corner_preference).cast(),
            size_of::<u32>() as u32,
        )
    };
    let border_color = SUPPRESS_WINDOW_BORDER_COLOR;
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            BORDER_COLOR_ATTRIBUTE,
            (&raw const border_color).cast(),
            size_of::<u32>() as u32,
        )
    };
}

fn is_chrome_widget(hwnd: HWND) -> bool {
    let mut buffer = [0_u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    length > 0
        && String::from_utf16_lossy(&buffer[..length as usize]).starts_with(CHROME_WIDGET_PREFIX)
}

fn read_outer_bounds(hwnd: HWND) -> Result<PixelBounds, PlatformError> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|error| PlatformError::Operation(error.to_string()))?;
    from_rect(rect)
}

fn read_visible_bounds(hwnd: HWND) -> Result<PixelBounds, PlatformError> {
    let mut rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut rect).cast(),
            size_of::<RECT>() as u32,
        )
    }
    .map_err(|error| PlatformError::Operation(error.to_string()))?;
    from_rect(rect)
}

fn from_rect(rect: RECT) -> Result<PixelBounds, PlatformError> {
    PixelBounds {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    }
    .validate()
}
