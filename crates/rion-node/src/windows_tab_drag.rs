use napi::{bindgen_prelude::*, threadsafe_function::ThreadsafeFunction};
use napi_derive::napi;
type Wake = ThreadsafeFunction<String, (), String, Status, false, false, 1>;

#[napi(js_name = "startWindowsTabDrag")]
pub fn start_windows_tab_drag(
    handle: Buffer,
    session_id: String,
    callback: Function<'_, String, ()>,
) -> Result<()> {
    let wake = callback
        .build_threadsafe_function::<String>()
        .max_queue_size::<1>()
        .build_callback(|context| Ok(context.value))?;
    platform::start(&handle, session_id, wake)
}
#[napi(js_name = "takeWindowsTabDragSample")]
pub fn take_windows_tab_drag_sample(session_id: String) -> Result<Option<String>> {
    platform::take(&session_id)
}
#[napi(js_name = "endWindowsTabDrag")]
pub fn end_windows_tab_drag(session_id: String) -> Result<()> {
    platform::end(&session_id)
}

/// Checks native z-order, including foreign windows, at the sampled desktop point.
#[napi(js_name = "windowsTabDragHitTest")]
pub fn windows_tab_drag_hit_test(handle: Buffer, x: i32, y: i32) -> Result<bool> {
    platform::hit_test(&handle, x, y)
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn hit_test(_: &Buffer, _: i32, _: i32) -> Result<bool> {
        Err(Error::from_reason("Windows tab gestures require Windows."))
    }
    pub fn start(_: &Buffer, _: String, _: Wake) -> Result<()> {
        Err(Error::from_reason("Windows tab gestures require Windows."))
    }
    pub fn take(_: &str) -> Result<Option<String>> {
        Err(Error::from_reason("Windows tab gestures require Windows."))
    }
    pub fn end(_: &str) -> Result<()> {
        Err(Error::from_reason("Windows tab gestures require Windows."))
    }
}
#[cfg(windows)]
mod platform {
    use super::*;
    use napi::threadsafe_function::ThreadsafeFunctionCallMode;
    use std::{
        cell::RefCell,
        panic::{AssertUnwindSafe, catch_unwind},
    };
    use windows::Win32::{
        Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM},
        System::{
            LibraryLoader::{
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, GetModuleHandleExW,
            },
            Threading::{GetCurrentProcessId, GetCurrentThreadId},
        },
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    };
    use windows::core::PCWSTR;
    const SUBCLASS: usize = 0x5249_4452;
    struct Drag {
        id: String,
        hwnd: HWND,
        wake: Wake,
        keyboard: HHOOK,
        mouse: HHOOK,
        pending: bool,
        terminal: bool,
        point: (i32, i32),
        sample: Option<String>,
    }
    impl Drop for Drag {
        fn drop(&mut self) {
            // SAFETY: handles belong to this exact UI-thread subscription.
            unsafe {
                let _ = UnhookWindowsHookEx(self.keyboard);
                let _ = UnhookWindowsHookEx(self.mouse);
                let _ = RemoveWindowSubclass(self.hwnd, Some(subclass), SUBCLASS);
            }
        }
    }
    thread_local! { static DRAG: RefCell<Option<Drag>> = const { RefCell::new(None) }; }
    fn observe(phase: &str, point: Option<(i32, i32)>) {
        DRAG.with(|cell| {
            let mut current = cell.borrow_mut();
            let Some(drag) = current.as_mut() else {
                return;
            };
            if drag.terminal {
                return;
            }
            if let Some(point) = point {
                drag.point = point;
            }
            drag.terminal = phase != "move";
            drag.sample = Some(
                serde_json::json!({"sessionId":drag.id,"phase":phase,
                "x":drag.point.0,"y":drag.point.1})
                .to_string(),
            );
            if !drag.pending {
                drag.pending = true;
                if drag
                    .wake
                    .call(drag.id.clone(), ThreadsafeFunctionCallMode::NonBlocking)
                    != Status::Ok
                {
                    // A dead JS event stream must not retain desktop hooks.
                    current.take();
                }
            }
        });
    }
    unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if code != HC_ACTION as i32 {
                return;
            }
            let phase = match wparam.0 as u32 {
                WM_MOUSEMOVE => "move",
                WM_LBUTTONUP => "end",
                _ => return,
            };
            // SAFETY: Windows retains MSLLHOOKSTRUCT for this callback.
            let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            observe(phase, Some((event.pt.x, event.pt.y)));
        }));
        // Observes ordinary UI input, including accessibility-generated input;
        // it is not a trusted macro-input evidence channel and consumes nothing.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
    unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if code != HC_ACTION as i32 || wparam.0 as u32 != WM_KEYDOWN {
                return;
            }
            // SAFETY: Windows retains KBDLLHOOKSTRUCT for this callback.
            if unsafe { (*(lparam.0 as *const KBDLLHOOKSTRUCT)).vkCode } == 0x1b {
                observe("cancel", None);
            }
        }));
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
    unsafe extern "system" fn subclass(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            let _ = catch_unwind(AssertUnwindSafe(|| observe("cancel", None)));
        }
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }
    pub fn hit_test(handle: &Buffer, x: i32, y: i32) -> Result<bool> {
        let hwnd = HWND(crate::windows_native_handle::parse_electron_native_handle(
            handle,
            "tab drag destination",
        )? as *mut std::ffi::c_void);
        // SAFETY: read-only native point/ancestor queries; no pointer dereference.
        let actual = unsafe {
            GetAncestor(
                WindowFromPoint(windows::Win32::Foundation::POINT { x, y }),
                GA_ROOT,
            )
        };
        Ok(actual == hwnd)
    }
    pub fn start(handle: &Buffer, id: String, wake: Wake) -> Result<()> {
        let hwnd = HWND(crate::windows_native_handle::parse_electron_native_handle(
            handle,
            "tab drag source",
        )? as *mut std::ffi::c_void);
        if id.is_empty() || id.len() > 256 {
            return Err(Error::from_reason("Invalid tab gesture identity."));
        }
        let mut process = 0;
        // SAFETY: only querying the supplied handle; no dereference.
        let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut process)) };
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool()
            || process != unsafe { GetCurrentProcessId() }
            || thread != unsafe { GetCurrentThreadId() }
        {
            return Err(Error::from_reason(
                "Tab gesture source is not the exact Electron UI HWND.",
            ));
        }
        DRAG.with(|cell| {
            cell.borrow_mut().take();
        });
        let mut module = HMODULE::default();
        // SAFETY: static function address belongs to this loaded addon.
        unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                    | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                PCWSTR(mouse as *const () as *const u16),
                &raw mut module,
            )
        }
        .map_err(|e| Error::from_reason(e.to_string()))?;
        let keyboard =
            unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), Some(module.into()), 0) }
                .map_err(|e| Error::from_reason(e.to_string()))?;
        let mouse =
            match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), Some(module.into()), 0) } {
                Ok(hook) => hook,
                Err(e) => {
                    let _ = unsafe { UnhookWindowsHookEx(keyboard) };
                    return Err(Error::from_reason(e.to_string()));
                }
            };
        let mut point = windows::Win32::Foundation::POINT::default();
        if unsafe { GetCursorPos(&raw mut point) }.is_err()
            || !unsafe { SetWindowSubclass(hwnd, Some(subclass), SUBCLASS, 0) }.as_bool()
        {
            let _ = unsafe { UnhookWindowsHookEx(keyboard) };
            let _ = unsafe { UnhookWindowsHookEx(mouse) };
            return Err(Error::from_reason(
                "Cannot observe the native tab gesture source.",
            ));
        }
        DRAG.with(|cell| {
            *cell.borrow_mut() = Some(Drag {
                id,
                hwnd,
                wake,
                keyboard,
                mouse,
                pending: false,
                terminal: false,
                point: (point.x, point.y),
                sample: None,
            });
        });
        // Registration can race the physical release while the renderer IPC is
        // in flight. This one boundary observation seals that already-ended gesture.
        if unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON.0)) } >= 0 {
            observe("end", Some((point.x, point.y)));
        } else {
            observe("move", Some((point.x, point.y)));
        }
        Ok(())
    }
    pub fn take(id: &str) -> Result<Option<String>> {
        Ok(DRAG.with(|cell| {
            let mut current = cell.borrow_mut();
            let drag = current.as_mut().filter(|drag| drag.id == id)?;
            drag.pending = false;
            drag.sample.take()
        }))
    }
    pub fn end(id: &str) -> Result<()> {
        DRAG.with(|cell| {
            let mut current = cell.borrow_mut();
            if current.as_ref().is_some_and(|drag| drag.id == id) {
                current.take();
            }
        });
        Ok(())
    }
}
