use std::sync::Weak;

use crate::system_runtime::SystemRuntimeExecutor;

#[cfg(target_os = "macos")]
mod platform {
    use std::{ffi::c_void, sync::Mutex};

    use super::*;

    type PowerCallback = unsafe extern "C" fn(*mut c_void, bool, *const std::ffi::c_char);
    type DisplayCallback = unsafe extern "C" fn(*mut c_void, *const std::ffi::c_char);
    type ForegroundCallback = unsafe extern "C" fn(*mut c_void, bool);
    type ContextDestructor = unsafe extern "C" fn(*mut c_void);

    unsafe extern "C" {
        fn rion_power_monitor_create(
            callback: PowerCallback,
            display_callback: DisplayCallback,
            foreground_callback: ForegroundCallback,
            context: *mut c_void,
            context_destructor: ContextDestructor,
        ) -> *mut c_void;
        fn rion_power_monitor_release(monitor: *mut c_void);
    }

    struct CallbackContext {
        runtime: Weak<SystemRuntimeExecutor>,
    }

    unsafe extern "C" fn power_callback(
        context: *mut c_void,
        suspended: bool,
        reason: *const std::ffi::c_char,
    ) {
        if context.is_null() || reason.is_null() {
            return;
        }
        let context = unsafe { &*(context as *const CallbackContext) };
        let Some(runtime) = context.runtime.upgrade() else {
            return;
        };
        let reason = unsafe { std::ffi::CStr::from_ptr(reason) }
            .to_string_lossy()
            .into_owned();
        runtime.enqueue_application_lifecycle_signal(suspended, reason);
    }

    unsafe extern "C" fn drop_callback_context(context: *mut c_void) {
        if !context.is_null() {
            drop(unsafe { Box::from_raw(context as *mut CallbackContext) });
        }
    }

    unsafe extern "C" fn display_callback(context: *mut c_void, reason: *const std::ffi::c_char) {
        if context.is_null() || reason.is_null() {
            return;
        }
        let context = unsafe { &*(context as *const CallbackContext) };
        let Some(runtime) = context.runtime.upgrade() else {
            return;
        };
        let reason = unsafe { std::ffi::CStr::from_ptr(reason) }
            .to_string_lossy()
            .into_owned();
        runtime.request_display_topology_refresh(&reason);
    }

    unsafe extern "C" fn foreground_callback(context: *mut c_void, foreground: bool) {
        if context.is_null() {
            return;
        }
        let context = unsafe { &*(context as *const CallbackContext) };
        if let Some(runtime) = context.runtime.upgrade() {
            runtime.observe_application_foreground(foreground);
        }
    }

    pub(crate) struct PowerMonitor {
        raw: Mutex<usize>,
    }

    impl PowerMonitor {
        pub(crate) fn install(runtime: Weak<SystemRuntimeExecutor>) -> Result<Self, String> {
            let context = Box::into_raw(Box::new(CallbackContext { runtime })) as *mut c_void;
            let raw = unsafe {
                rion_power_monitor_create(
                    power_callback,
                    display_callback,
                    foreground_callback,
                    context,
                    drop_callback_context,
                )
            };
            if raw.is_null() {
                unsafe { drop_callback_context(context) };
                return Err("macOS power notifications could not be installed.".to_owned());
            }
            Ok(Self {
                raw: Mutex::new(raw as usize),
            })
        }
    }

    impl Drop for PowerMonitor {
        fn drop(&mut self) {
            let raw = self.raw.get_mut().ok().map(|raw| *raw).unwrap_or_default();
            if raw != 0 {
                unsafe { rion_power_monitor_release(raw as *mut c_void) };
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::{
        sync::{Mutex, OnceLock},
        thread,
    };

    use super::*;
    use windows::{
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, WPARAM},
            System::LibraryLoader::GetModuleHandleW,
            UI::{
                Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent},
                WindowsAndMessaging::{
                    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
                    EVENT_SYSTEM_FOREGROUND, GetForegroundWindow, GetMessageW,
                    GetWindowThreadProcessId, MSG, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMECRITICAL,
                    PBT_APMRESUMESTANDBY, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, PostMessageW,
                    PostQuitMessage, RegisterClassW, TranslateMessage, WINDOW_EX_STYLE,
                    WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WM_CLOSE, WM_DESTROY, WM_DISPLAYCHANGE,
                    WM_POWERBROADCAST, WNDCLASSW,
                },
            },
        },
        core::w,
    };

    static POWER_RUNTIME: OnceLock<Mutex<Option<Weak<SystemRuntimeExecutor>>>> = OnceLock::new();

    unsafe extern "system" fn foreground_event_callback(
        _hook: HWINEVENTHOOK,
        _event: u32,
        window: HWND,
        _object_id: i32,
        _child_id: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        let mut process_id = 0_u32;
        if !window.0.is_null() {
            unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
        }
        let runtime = POWER_RUNTIME
            .get()
            .and_then(|runtime| runtime.lock().ok())
            .and_then(|runtime| runtime.as_ref().cloned())
            .and_then(|runtime| runtime.upgrade());
        if let Some(runtime) = runtime {
            runtime.observe_application_foreground(process_id == std::process::id());
        }
    }

    unsafe extern "system" fn power_window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_DISPLAYCHANGE => {
                let runtime = POWER_RUNTIME
                    .get()
                    .and_then(|runtime| runtime.lock().ok())
                    .and_then(|runtime| runtime.as_ref().cloned())
                    .and_then(|runtime| runtime.upgrade());
                if let Some(runtime) = runtime {
                    runtime.request_display_topology_refresh("windows-display-change");
                }
                LRESULT(0)
            }
            WM_POWERBROADCAST => {
                let event = wparam.0 as u32;
                let signal = match event {
                    PBT_APMSUSPEND => Some((true, "windows-power-suspend")),
                    PBT_APMRESUMEAUTOMATIC
                    | PBT_APMRESUMECRITICAL
                    | PBT_APMRESUMESTANDBY
                    | PBT_APMRESUMESUSPEND => Some((false, "windows-power-resume")),
                    _ => None,
                };
                if let Some((suspended, reason)) = signal {
                    let runtime = POWER_RUNTIME
                        .get()
                        .and_then(|runtime| runtime.lock().ok())
                        .and_then(|runtime| runtime.as_ref().cloned())
                        .and_then(|runtime| runtime.upgrade());
                    if let Some(runtime) = runtime {
                        runtime.enqueue_application_lifecycle_signal(suspended, reason);
                    }
                    LRESULT(1)
                } else {
                    unsafe { DefWindowProcW(window, message, wparam, lparam) }
                }
            }
            WM_CLOSE => {
                let _ = unsafe { DestroyWindow(window) };
                LRESULT(0)
            }
            WM_DESTROY => {
                unsafe { PostQuitMessage(0) };
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
        }
    }

    pub(crate) struct PowerMonitor {
        window: isize,
        worker: Mutex<Option<thread::JoinHandle<()>>>,
    }

    impl PowerMonitor {
        pub(crate) fn install(runtime: Weak<SystemRuntimeExecutor>) -> Result<Self, String> {
            *POWER_RUNTIME
                .get_or_init(|| Mutex::new(None))
                .lock()
                .map_err(|_| "The Windows power callback state is unavailable.".to_owned())? =
                Some(runtime);
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let worker = thread::Builder::new()
                .name("rion-windows-power-events".to_owned())
                .spawn(move || {
                    let instance = unsafe { GetModuleHandleW(None) }.ok();
                    let class = WNDCLASSW {
                        hInstance: instance.map(Into::into).unwrap_or_default(),
                        lpfnWndProc: Some(power_window_proc),
                        lpszClassName: w!("RionStudioPowerLifecycle"),
                        ..Default::default()
                    };
                    unsafe { RegisterClassW(&class) };
                    let window = unsafe {
                        CreateWindowExW(
                            WINDOW_EX_STYLE::default(),
                            w!("RionStudioPowerLifecycle"),
                            w!("Rion Studio Power Lifecycle"),
                            WINDOW_STYLE::default(),
                            0,
                            0,
                            0,
                            0,
                            None,
                            None,
                            instance.map(Into::into),
                            None,
                        )
                    };
                    let Ok(window) = window else {
                        let _ = sender.send(Err(
                            "Windows power message window creation failed.".to_owned()
                        ));
                        return;
                    };
                    let foreground_hook = unsafe {
                        SetWinEventHook(
                            EVENT_SYSTEM_FOREGROUND,
                            EVENT_SYSTEM_FOREGROUND,
                            None,
                            Some(foreground_event_callback),
                            0,
                            0,
                            WINEVENT_OUTOFCONTEXT,
                        )
                    };
                    if foreground_hook.0.is_null() {
                        let _ = unsafe { DestroyWindow(window) };
                        let _ = sender.send(Err(
                            "Windows foreground event hook installation failed.".to_owned(),
                        ));
                        return;
                    }
                    let foreground = unsafe { GetForegroundWindow() };
                    unsafe {
                        foreground_event_callback(
                            foreground_hook,
                            EVENT_SYSTEM_FOREGROUND,
                            foreground,
                            0,
                            0,
                            0,
                            0,
                        );
                    }
                    let _ = sender.send(Ok(window.0 as isize));
                    let mut message = MSG::default();
                    loop {
                        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
                        if result.0 <= 0 {
                            break;
                        }
                        unsafe {
                            let _ = TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                    let _ = unsafe { UnhookWinEvent(foreground_hook) };
                })
                .map_err(|error| error.to_string())?;
            let window = receiver
                .recv_timeout(std::time::Duration::from_secs(2))
                .map_err(|_| "Windows power message window creation timed out.".to_owned())??;
            Ok(Self {
                window,
                worker: Mutex::new(Some(worker)),
            })
        }
    }

    impl Drop for PowerMonitor {
        fn drop(&mut self) {
            if let Ok(mut runtime) = POWER_RUNTIME.get_or_init(|| Mutex::new(None)).lock() {
                *runtime = None;
            }
            let posted = unsafe {
                PostMessageW(
                    Some(HWND(self.window as *mut _)),
                    WM_CLOSE,
                    WPARAM::default(),
                    LPARAM::default(),
                )
            }
            .is_ok();
            if posted
                && let Ok(worker) = self.worker.get_mut()
                && let Some(worker) = worker.take()
            {
                let _ = worker.join();
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;

    pub(crate) struct PowerMonitor;

    impl PowerMonitor {
        pub(crate) fn install(_runtime: Weak<SystemRuntimeExecutor>) -> Result<Self, String> {
            Ok(Self)
        }
    }
}

pub(crate) use platform::PowerMonitor;
