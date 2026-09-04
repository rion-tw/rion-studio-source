#[cfg(windows)]
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{
    Status,
    bindgen_prelude::{Buffer, Function, Result},
};
use napi_derive::napi;

#[cfg(windows)]
use crate::windows_chromium_input_probe::parse_electron_native_handle;
use crate::windows_chromium_input_probe::probe_error;

#[cfg(windows)]
const WINDOWS_RUNTIME_SHORTCUT_QUEUE_CAPACITY: usize = 32;

#[cfg(windows)]
type WindowsRuntimeShortcutCallback =
    ThreadsafeFunction<(), (), (), Status, false, false, WINDOWS_RUNTIME_SHORTCUT_QUEUE_CAPACITY>;
#[cfg(windows)]
type WindowsRuntimeShortcutFailureCallback =
    ThreadsafeFunction<String, (), (String,), Status, false, false, 1>;

#[napi(object)]
pub struct WindowsRuntimeShortcutOwnerReceipt {
    pub owner_revision: String,
    pub ui_thread_id: u32,
    pub registered: bool,
}

#[napi(object)]
pub struct WindowsRuntimeShortcutOwnerDiagnostic {
    pub owner_revision: String,
    pub ui_thread_id: u32,
    pub callback_deliveries: u32,
    pub hook_callbacks: u32,
    pub f11_events: u32,
    pub foreground_matches: u32,
    pub plain_key_downs: u32,
    pub callback_submissions: u32,
    pub callback_rejections: u32,
}

#[cfg(any(windows, test))]
fn parse_owner_revision(value: &str) -> Result<u64> {
    let parsed = value.parse::<u64>().map_err(|_| {
        probe_error(
            Status::InvalidArg,
            "The Windows runtime shortcut owner revision must be a canonical positive integer.",
        )
    })?;
    if parsed == 0 || parsed.to_string() != value {
        return Err(probe_error(
            Status::InvalidArg,
            "The Windows runtime shortcut owner revision must be a canonical positive integer.",
        ));
    }
    Ok(parsed)
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WindowsRuntimeF11Action {
    PassThrough,
    Consume,
    EmitAndConsume,
}

#[cfg(any(windows, test))]
fn classify_f11_transition(
    plain_f11: bool,
    released: bool,
    captured_down: bool,
) -> (WindowsRuntimeF11Action, bool) {
    if released {
        return if captured_down {
            // The key-up is the exact terminal event for the captured native
            // chord. Dispatch only after SendInput and the low-level hook have
            // finished the complete key cycle; entering Chromium fullscreen
            // from the key-down callback can otherwise remain re-entrant with
            // the originating Windows input transaction.
            (WindowsRuntimeF11Action::EmitAndConsume, false)
        } else {
            (WindowsRuntimeF11Action::PassThrough, false)
        };
    }
    if captured_down {
        return (WindowsRuntimeF11Action::Consume, true);
    }
    if plain_f11 {
        (WindowsRuntimeF11Action::Consume, true)
    } else {
        (WindowsRuntimeF11Action::PassThrough, false)
    }
}

#[cfg(windows)]
mod platform {
    use std::{
        cell::RefCell,
        collections::HashMap,
        panic::{AssertUnwindSafe, catch_unwind},
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicU32, Ordering},
            mpsc::{SyncSender, TrySendError, sync_channel},
        },
        thread::{self, JoinHandle},
    };

    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::{
            LibraryLoader::{
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, GetModuleHandleExW,
            },
            Threading::{GetCurrentProcessId, GetCurrentThreadId},
        },
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, VK_CONTROL, VK_F11, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
            },
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                CallNextHookEx, GetForegroundWindow, GetWindowThreadProcessId, HC_ACTION, HHOOK,
                IsWindow, KBDLLHOOKSTRUCT, LLKHF_UP, SetWindowsHookExW, UnhookWindowsHookEx,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_NCDESTROY, WM_SYSKEYDOWN,
            },
        },
    };
    use windows::core::PCWSTR;

    use super::*;

    const RION_RUNTIME_SHORTCUT_SUBCLASS_ID: usize = 0x5249_4f4e;

    #[derive(Default)]
    struct ShortcutDispatchState {
        callback_rejections: AtomicU32,
        callback_submissions: AtomicU32,
        failed: AtomicBool,
        failure_pending: AtomicBool,
    }

    enum ShortcutDispatchMessage {
        Emit,
        Shutdown,
    }

    struct ShortcutDispatchWorker {
        sender: SyncSender<ShortcutDispatchMessage>,
        state: Arc<ShortcutDispatchState>,
        thread: Option<JoinHandle<()>>,
    }

    impl ShortcutDispatchWorker {
        fn start(
            owner_revision: u64,
            callback: WindowsRuntimeShortcutCallback,
            failure_callback: WindowsRuntimeShortcutFailureCallback,
        ) -> Result<Self> {
            let (sender, receiver) = sync_channel(WINDOWS_RUNTIME_SHORTCUT_QUEUE_CAPACITY);
            let state = Arc::new(ShortcutDispatchState::default());
            let worker_state = Arc::clone(&state);
            let worker = thread::Builder::new()
                .name(format!("rion-runtime-shortcut-{owner_revision}"))
                .spawn(move || {
                    let report_failure = || {
                        if worker_state.failure_pending.swap(false, Ordering::AcqRel) {
                            let _ = failure_callback.call(
                                "The bounded Windows runtime shortcut callback queue rejected F11."
                                    .to_owned(),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                        }
                    };
                    while let Ok(message) = receiver.recv() {
                        match message {
                            ShortcutDispatchMessage::Emit => {
                                if !worker_state.failed.load(Ordering::Acquire) {
                                    worker_state
                                        .callback_submissions
                                        .fetch_add(1, Ordering::Relaxed);
                                    if callback.call((), ThreadsafeFunctionCallMode::NonBlocking)
                                        != Status::Ok
                                    {
                                        worker_state
                                            .callback_rejections
                                            .fetch_add(1, Ordering::Relaxed);
                                        worker_state.failed.store(true, Ordering::Release);
                                        worker_state.failure_pending.store(true, Ordering::Release);
                                    }
                                }
                                report_failure();
                            }
                            ShortcutDispatchMessage::Shutdown => {
                                report_failure();
                                break;
                            }
                        }
                    }
                })
                .map_err(|_| {
                    probe_error(
                        Status::GenericFailure,
                        "Win32 could not start the bounded runtime shortcut dispatcher.",
                    )
                })?;
            Ok(Self {
                sender,
                state,
                thread: Some(worker),
            })
        }

        fn emit(&self) {
            if self.state.failed.load(Ordering::Acquire) {
                return;
            }
            if let Err(error) = self.sender.try_send(ShortcutDispatchMessage::Emit) {
                self.state
                    .callback_rejections
                    .fetch_add(1, Ordering::Relaxed);
                self.state.failed.store(true, Ordering::Release);
                self.state.failure_pending.store(true, Ordering::Release);
                if matches!(error, TrySendError::Disconnected(_)) {
                    self.state.failure_pending.store(false, Ordering::Release);
                }
            }
        }

        fn callback_submissions(&self) -> u32 {
            self.state.callback_submissions.load(Ordering::Relaxed)
        }

        fn callback_rejections(&self) -> u32 {
            self.state.callback_rejections.load(Ordering::Relaxed)
        }

        fn shutdown(mut self) -> Result<()> {
            let submitted = self.sender.send(ShortcutDispatchMessage::Shutdown).is_ok();
            let joined = self
                .thread
                .take()
                .is_some_and(|worker| worker.join().is_ok());
            if submitted && joined {
                Ok(())
            } else {
                Err(probe_error(
                    Status::GenericFailure,
                    "The bounded Windows runtime shortcut dispatcher did not retire cleanly.",
                ))
            }
        }
    }

    struct ShortcutOwner {
        callback_deliveries: u32,
        captured_f11_down: bool,
        dispatch: ShortcutDispatchWorker,
        foreground_matches: u32,
        owner_revision: u64,
        plain_key_downs: u32,
    }

    impl ShortcutOwner {
        fn emit(&mut self) {
            self.dispatch.emit();
        }
    }

    #[derive(Default)]
    struct ShortcutRegistry {
        f11_events: u32,
        hook: Option<HHOOK>,
        hook_callbacks: u32,
        owners: HashMap<usize, ShortcutOwner>,
    }

    thread_local! {
        static SHORTCUT_REGISTRY: RefCell<ShortcutRegistry> =
            RefCell::new(ShortcutRegistry::default());
    }

    fn hwnd_key(hwnd: HWND) -> usize {
        hwnd.0 as usize
    }

    fn hwnd_from_key(key: usize) -> HWND {
        HWND(key as *mut core::ffi::c_void)
    }

    fn modifier_is_down(key: i32) -> bool {
        // SAFETY: the low-level keyboard callback runs before the state of its
        // current key is updated, so prior modifier transitions are already
        // reflected without retaining the virtual-key value.
        unsafe { GetAsyncKeyState(key) < 0 }
    }

    fn plain_f11() -> bool {
        !modifier_is_down(VK_CONTROL.0 as i32)
            && !modifier_is_down(VK_SHIFT.0 as i32)
            && !modifier_is_down(VK_MENU.0 as i32)
            && !modifier_is_down(VK_LWIN.0 as i32)
            && !modifier_is_down(VK_RWIN.0 as i32)
    }

    fn retire_destroyed_owner(hwnd: HWND) {
        let owner = SHORTCUT_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            let owner = registry.owners.remove(&hwnd_key(hwnd));
            if registry.owners.is_empty()
                && let Some(hook) = registry.hook.take()
            {
                // SAFETY: the hook was installed by this registry on this UI
                // thread and is retired exactly when its final HWND dies.
                let _ = unsafe { UnhookWindowsHookEx(hook) };
            }
            owner
        });
        if let Some(owner) = owner {
            let _ = owner.dispatch.shutdown();
        }
    }

    unsafe extern "system" fn runtime_window_subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        _reference_data: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            let _ = catch_unwind(AssertUnwindSafe(|| retire_destroyed_owner(hwnd)));
        }
        // SAFETY: every unhandled message must continue through the ComCtl32
        // subclass chain for the exact HWND supplied by Windows.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    unsafe extern "system" fn runtime_low_level_keyboard_hook(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let captured = catch_unwind(AssertUnwindSafe(|| {
            if code != HC_ACTION as i32 {
                return false;
            }
            // SAFETY: WH_KEYBOARD_LL supplies a valid KBDLLHOOKSTRUCT pointer
            // for HC_ACTION and retains it for the duration of this callback.
            let keyboard = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            SHORTCUT_REGISTRY.with(|registry| {
                let mut registry = registry.borrow_mut();
                registry.hook_callbacks = registry.hook_callbacks.saturating_add(1);
                if keyboard.vkCode != VK_F11.0 as u32 {
                    return false;
                }
                registry.f11_events = registry.f11_events.saturating_add(1);
                // SAFETY: this hook reads only the exact current foreground
                // HWND and never enumerates or guesses Chromium HWNDs.
                let foreground = unsafe { GetForegroundWindow() };
                let Some(owner) = registry.owners.get_mut(&hwnd_key(foreground)) else {
                    return false;
                };
                owner.foreground_matches = owner.foreground_matches.saturating_add(1);
                let released = keyboard.flags.contains(LLKHF_UP)
                    || (wparam.0 != WM_KEYDOWN as usize && wparam.0 != WM_SYSKEYDOWN as usize);
                let plain = plain_f11();
                if plain && !released && !owner.captured_f11_down {
                    owner.plain_key_downs = owner.plain_key_downs.saturating_add(1);
                }
                let (action, captured_f11_down) =
                    classify_f11_transition(plain, released, owner.captured_f11_down);
                owner.captured_f11_down = captured_f11_down;
                if action == WindowsRuntimeF11Action::EmitAndConsume {
                    owner.emit()
                }
                action != WindowsRuntimeF11Action::PassThrough
            })
        }))
        .unwrap_or(false);
        if captured {
            return LRESULT(1);
        }
        // SAFETY: unmatched messages must continue through the current thread's
        // keyboard-hook chain. Passing None is documented for this operation.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    fn hook_module() -> Result<windows::Win32::Foundation::HINSTANCE> {
        let mut module = windows::Win32::Foundation::HMODULE::default();
        let callback_address = runtime_low_level_keyboard_hook as *const () as *const u16;
        // SAFETY: FROM_ADDRESS treats the pointer as an address inside the
        // loaded rion_node module rather than reading it as a string. The
        // unchanged-refcount flag makes this a non-owning module lookup.
        unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                    | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                PCWSTR(callback_address),
                &mut module,
            )
        }
        .map_err(|_| {
            probe_error(
                Status::GenericFailure,
                "Win32 could not resolve the runtime shortcut hook module.",
            )
        })?;
        Ok(windows::Win32::Foundation::HINSTANCE(module.0))
    }

    fn validate_parent(parent: HWND) -> Result<u32> {
        // SAFETY: the opaque handle is validated before ownership queries. No
        // state is changed by these User32 calls.
        unsafe {
            if !IsWindow(Some(parent)).as_bool() {
                return Err(probe_error(
                    Status::InvalidArg,
                    "Electron supplied a stale Windows runtime shortcut parent handle.",
                ));
            }
            let current_process_id = GetCurrentProcessId();
            let current_thread_id = GetCurrentThreadId();
            let mut process_id = 0;
            let ui_thread_id = GetWindowThreadProcessId(parent, Some(&raw mut process_id));
            if ui_thread_id == 0
                || process_id != current_process_id
                || ui_thread_id != current_thread_id
            {
                return Err(probe_error(
                    Status::InvalidArg,
                    "The Windows runtime shortcut parent must belong to the calling Electron UI owner.",
                ));
            }
            Ok(ui_thread_id)
        }
    }

    pub(super) fn register(
        parent: HWND,
        owner_revision: u64,
        callback: WindowsRuntimeShortcutCallback,
        failure_callback: WindowsRuntimeShortcutFailureCallback,
    ) -> Result<u32> {
        let ui_thread_id = validate_parent(parent)?;
        SHORTCUT_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            let key = hwnd_key(parent);
            if registry.owners.contains_key(&key) {
                return Err(probe_error(
                    Status::InvalidArg,
                    "The Windows runtime HWND already has a shortcut owner.",
                ));
            }

            let installed_hook = if registry.hook.is_none() {
                let module = hook_module()?;
                // SAFETY: WH_KEYBOARD_LL is desktop-scoped but owned by
                // Electron's message-loop thread. The static callback forwards
                // every key except plain F11 while an exact registered Rion
                // runtime HWND is foreground, retains no unrelated input, and
                // remains valid while the rion_node module is loaded.
                let hook = unsafe {
                    SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(runtime_low_level_keyboard_hook),
                        Some(module),
                        0,
                    )
                }
                .map_err(|_| {
                    probe_error(
                        Status::GenericFailure,
                        "Win32 could not install the runtime keyboard shortcut owner.",
                    )
                })?;
                registry.hook_callbacks = 0;
                registry.f11_events = 0;
                registry.hook = Some(hook);
                true
            } else {
                false
            };

            // SAFETY: the exact same-process UI-thread HWND was validated
            // above. The subclass is used only for deterministic teardown.
            let subclassed = unsafe {
                SetWindowSubclass(
                    parent,
                    Some(runtime_window_subclass_proc),
                    RION_RUNTIME_SHORTCUT_SUBCLASS_ID,
                    0,
                )
                .as_bool()
            };
            if !subclassed {
                if installed_hook && let Some(hook) = registry.hook.take() {
                    // SAFETY: this call compensates the hook installed above.
                    let _ = unsafe { UnhookWindowsHookEx(hook) };
                }
                return Err(probe_error(
                    Status::GenericFailure,
                    "Win32 could not bind runtime shortcut teardown to the exact HWND.",
                ));
            }

            let dispatch =
                match ShortcutDispatchWorker::start(owner_revision, callback, failure_callback) {
                    Ok(dispatch) => dispatch,
                    Err(error) => {
                        // SAFETY: both resources were installed above on this
                        // exact UI thread and are compensated before returning.
                        let _ = unsafe {
                            RemoveWindowSubclass(
                                parent,
                                Some(runtime_window_subclass_proc),
                                RION_RUNTIME_SHORTCUT_SUBCLASS_ID,
                            )
                        };
                        if installed_hook && let Some(hook) = registry.hook.take() {
                            let _ = unsafe { UnhookWindowsHookEx(hook) };
                        }
                        return Err(error);
                    }
                };
            registry.owners.insert(
                key,
                ShortcutOwner {
                    callback_deliveries: 0,
                    captured_f11_down: false,
                    dispatch,
                    foreground_matches: 0,
                    owner_revision,
                    plain_key_downs: 0,
                },
            );
            Ok(ui_thread_id)
        })
    }

    pub(super) fn unregister(parent: HWND, owner_revision: u64) -> Result<bool> {
        let owner = SHORTCUT_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            let key = hwnd_key(parent);
            let Some(owner) = registry.owners.get(&key) else {
                return Ok(None);
            };
            if owner.owner_revision != owner_revision {
                return Err(probe_error(
                    Status::InvalidArg,
                    "The Windows runtime shortcut owner revision is stale.",
                ));
            }
            // A destroyed HWND has already passed through WM_NCDESTROY. For a
            // live HWND, removal must prove that no subclass callback remains.
            let live = unsafe { IsWindow(Some(parent)).as_bool() };
            if live
                && !unsafe {
                    RemoveWindowSubclass(
                        parent,
                        Some(runtime_window_subclass_proc),
                        RION_RUNTIME_SHORTCUT_SUBCLASS_ID,
                    )
                    .as_bool()
                }
            {
                return Err(probe_error(
                    Status::GenericFailure,
                    "Win32 could not remove the exact runtime shortcut teardown owner.",
                ));
            }
            let owner = registry.owners.remove(&key);
            if registry.owners.is_empty()
                && let Some(hook) = registry.hook.take()
            {
                // SAFETY: this is the current thread's registry-owned hook.
                unsafe { UnhookWindowsHookEx(hook) }.map_err(|_| {
                    probe_error(
                        Status::GenericFailure,
                        "Win32 could not remove the runtime keyboard shortcut owner.",
                    )
                })?;
            }
            Ok(owner)
        })?;
        let Some(owner) = owner else {
            return Ok(false);
        };
        owner.dispatch.shutdown()?;
        Ok(true)
    }

    pub(super) fn read(parent: HWND) -> Result<WindowsRuntimeShortcutOwnerDiagnostic> {
        let ui_thread_id = validate_parent(parent)?;
        SHORTCUT_REGISTRY.with(|registry| {
            let registry = registry.borrow();
            let Some(owner) = registry.owners.get(&hwnd_key(parent)) else {
                return Err(probe_error(
                    Status::InvalidArg,
                    "The Windows runtime HWND has no active shortcut owner.",
                ));
            };
            Ok(WindowsRuntimeShortcutOwnerDiagnostic {
                owner_revision: owner.owner_revision.to_string(),
                ui_thread_id,
                callback_deliveries: owner.callback_deliveries,
                hook_callbacks: registry.hook_callbacks,
                f11_events: registry.f11_events,
                foreground_matches: owner.foreground_matches,
                plain_key_downs: owner.plain_key_downs,
                callback_submissions: owner.dispatch.callback_submissions(),
                callback_rejections: owner.dispatch.callback_rejections(),
            })
        })
    }

    pub(super) fn acknowledge(parent: HWND, owner_revision: u64) -> Result<u32> {
        let ui_thread_id = validate_parent(parent)?;
        SHORTCUT_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            let Some(owner) = registry.owners.get_mut(&hwnd_key(parent)) else {
                return Err(probe_error(
                    Status::InvalidArg,
                    "The Windows runtime HWND has no active shortcut owner.",
                ));
            };
            if owner.owner_revision != owner_revision {
                return Err(probe_error(
                    Status::InvalidArg,
                    "The Windows runtime shortcut delivery revision is stale.",
                ));
            }
            owner.callback_deliveries = owner.callback_deliveries.saturating_add(1);
            Ok(ui_thread_id)
        })
    }

    pub(super) fn hwnd(address: usize) -> HWND {
        hwnd_from_key(address)
    }
}

#[cfg(windows)]
#[napi(js_name = "registerWindowsRuntimeShortcutOwner")]
pub fn register_windows_runtime_shortcut_owner(
    parent_handle: Buffer,
    owner_revision: String,
    callback: Function<'_, (), ()>,
    failure_callback: Function<'_, (String,), ()>,
) -> Result<WindowsRuntimeShortcutOwnerReceipt> {
    let parent_address = parse_electron_native_handle(&parent_handle, "parent")?;
    let parsed_revision = parse_owner_revision(&owner_revision)?;
    let callback = callback
        .build_threadsafe_function::<()>()
        .max_queue_size::<WINDOWS_RUNTIME_SHORTCUT_QUEUE_CAPACITY>()
        .build_callback(|_| Ok(()))?;
    let failure_callback = failure_callback
        .build_threadsafe_function::<String>()
        .max_queue_size::<1>()
        .build_callback(|context| Ok((context.value,)))?;
    let ui_thread_id = platform::register(
        platform::hwnd(parent_address),
        parsed_revision,
        callback,
        failure_callback,
    )?;
    Ok(WindowsRuntimeShortcutOwnerReceipt {
        owner_revision,
        ui_thread_id,
        registered: true,
    })
}

#[cfg(not(windows))]
#[napi(js_name = "registerWindowsRuntimeShortcutOwner")]
pub fn register_windows_runtime_shortcut_owner(
    _parent_handle: Buffer,
    _owner_revision: String,
    _callback: Function<'_, (), ()>,
    _failure_callback: Function<'_, (String,), ()>,
) -> Result<WindowsRuntimeShortcutOwnerReceipt> {
    Err(probe_error(
        Status::GenericFailure,
        "The Win32 runtime shortcut owner is available only on Windows.",
    ))
}

#[cfg(windows)]
#[napi(js_name = "unregisterWindowsRuntimeShortcutOwner")]
pub fn unregister_windows_runtime_shortcut_owner(
    parent_handle: Buffer,
    owner_revision: String,
) -> Result<WindowsRuntimeShortcutOwnerReceipt> {
    let parent_address = parse_electron_native_handle(&parent_handle, "parent")?;
    let parsed_revision = parse_owner_revision(&owner_revision)?;
    let registered = platform::unregister(platform::hwnd(parent_address), parsed_revision)?;
    // The thread identity remains authoritative even when WM_NCDESTROY already
    // retired the exact owner before Electron emitted `closed`.
    let ui_thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    Ok(WindowsRuntimeShortcutOwnerReceipt {
        owner_revision,
        ui_thread_id,
        registered,
    })
}

#[cfg(windows)]
#[napi(js_name = "readWindowsRuntimeShortcutOwner")]
pub fn read_windows_runtime_shortcut_owner(
    parent_handle: Buffer,
) -> Result<WindowsRuntimeShortcutOwnerDiagnostic> {
    let parent_address = parse_electron_native_handle(&parent_handle, "parent")?;
    platform::read(platform::hwnd(parent_address))
}

#[cfg(windows)]
#[napi(js_name = "acknowledgeWindowsRuntimeShortcutOwner")]
pub fn acknowledge_windows_runtime_shortcut_owner(
    parent_handle: Buffer,
    owner_revision: String,
) -> Result<WindowsRuntimeShortcutOwnerReceipt> {
    let parent_address = parse_electron_native_handle(&parent_handle, "parent")?;
    let parsed_revision = parse_owner_revision(&owner_revision)?;
    let ui_thread_id = platform::acknowledge(platform::hwnd(parent_address), parsed_revision)?;
    Ok(WindowsRuntimeShortcutOwnerReceipt {
        owner_revision,
        ui_thread_id,
        registered: true,
    })
}

#[cfg(not(windows))]
#[napi(js_name = "readWindowsRuntimeShortcutOwner")]
pub fn read_windows_runtime_shortcut_owner(
    _parent_handle: Buffer,
) -> Result<WindowsRuntimeShortcutOwnerDiagnostic> {
    Err(probe_error(
        Status::GenericFailure,
        "The Win32 runtime shortcut owner is available only on Windows.",
    ))
}

#[cfg(not(windows))]
#[napi(js_name = "acknowledgeWindowsRuntimeShortcutOwner")]
pub fn acknowledge_windows_runtime_shortcut_owner(
    _parent_handle: Buffer,
    _owner_revision: String,
) -> Result<WindowsRuntimeShortcutOwnerReceipt> {
    Err(probe_error(
        Status::GenericFailure,
        "The Win32 runtime shortcut owner is available only on Windows.",
    ))
}

#[cfg(not(windows))]
#[napi(js_name = "unregisterWindowsRuntimeShortcutOwner")]
pub fn unregister_windows_runtime_shortcut_owner(
    _parent_handle: Buffer,
    _owner_revision: String,
) -> Result<WindowsRuntimeShortcutOwnerReceipt> {
    Err(probe_error(
        Status::GenericFailure,
        "The Win32 runtime shortcut owner is available only on Windows.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_revision_requires_canonical_positive_u64() {
        assert_eq!(parse_owner_revision("1").expect("revision"), 1);
        assert_eq!(
            parse_owner_revision("18446744073709551615").expect("max revision"),
            u64::MAX
        );
        for invalid in ["", "0", "01", "+1", "-1", "18446744073709551616"] {
            assert!(parse_owner_revision(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn f11_transition_owns_one_plain_key_cycle_without_stealing_modifiers() {
        assert_eq!(
            classify_f11_transition(true, false, false),
            (WindowsRuntimeF11Action::Consume, true)
        );
        assert_eq!(
            classify_f11_transition(false, false, true),
            (WindowsRuntimeF11Action::Consume, true)
        );
        assert_eq!(
            classify_f11_transition(false, true, true),
            (WindowsRuntimeF11Action::EmitAndConsume, false)
        );
        assert_eq!(
            classify_f11_transition(false, false, false),
            (WindowsRuntimeF11Action::PassThrough, false)
        );
        assert_eq!(
            classify_f11_transition(true, true, false),
            (WindowsRuntimeF11Action::PassThrough, false)
        );
    }
}
