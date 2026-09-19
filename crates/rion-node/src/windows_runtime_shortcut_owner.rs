use crate::physical_key_evidence::PhysicalKeyboardEvidence;
use napi::{
    Status,
    bindgen_prelude::{Buffer, Result},
};
use napi_derive::napi;

#[cfg(windows)]
use crate::windows_native_handle::parse_electron_native_handle;
use crate::windows_native_handle::probe_error;

#[napi(object)]
pub struct WindowsRuntimeShortcutOwnerReceipt {
    pub owner_revision: String,
    pub ui_thread_id: u32,
    pub registered: bool,
}

/// Physical-input evidence counters for the exact registered runtime HWND. The
/// owner observes input; it consumes no key and dispatches no shortcut.
#[napi(object)]
pub struct WindowsRuntimeShortcutOwnerDiagnostic {
    pub owner_revision: String,
    pub ui_thread_id: u32,
    pub hook_callbacks: u32,
    pub foreground_matches: u32,
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

#[cfg(windows)]
mod platform {
    use std::{
        cell::RefCell,
        collections::HashMap,
        panic::{AssertUnwindSafe, catch_unwind},
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
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                CallNextHookEx, GetForegroundWindow, GetWindowThreadProcessId, HC_ACTION, HHOOK,
                IsWindow, KBDLLHOOKSTRUCT, LLKHF_UP, LLMHF_INJECTED, MSLLHOOKSTRUCT,
                SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN,
                WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_NCDESTROY,
                WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
            },
        },
    };
    use windows::core::PCWSTR;

    use super::*;

    const RION_RUNTIME_SHORTCUT_SUBCLASS_ID: usize = 0x5249_4f4e;

    struct ShortcutOwner {
        foreground_matches: u32,
        owner_revision: u64,
        physical_input_sequence: u64,
        physical_keyboard_sequence: u64,
        physical_key_events:
            std::collections::VecDeque<crate::physical_key_evidence::PhysicalKeyEvidence>,
        physical_held_codes: std::collections::HashSet<String>,
    }

    impl ShortcutOwner {
        fn record_key(&mut self, vk: u32, scan: u32, flags: u32, released: bool) {
            let code = crate::physical_key_evidence::windows_key_code(vk, scan, flags & 1 != 0);
            let repeat = if released {
                self.physical_held_codes.remove(&code);
                false
            } else {
                !self.physical_held_codes.insert(code.clone())
            };
            self.physical_keyboard_sequence = self.physical_keyboard_sequence.saturating_add(1);
            self.physical_key_events
                .push_back(crate::physical_key_evidence::PhysicalKeyEvidence {
                    sequence: self.physical_keyboard_sequence.to_string(),
                    code,
                    event_type: if released { "keyup" } else { "keydown" }.into(),
                    repeat,
                    // This owner never consumes a key; macOS is the only host
                    // that reports a consumed physical edge.
                    consumed: false,
                });
            if self.physical_key_events.len() > 128 {
                self.physical_key_events.pop_front();
            }
        }
    }

    #[derive(Default)]
    struct ShortcutRegistry {
        keyboard_hook: Option<HHOOK>,
        mouse_hook: Option<HHOOK>,
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

    fn retire_destroyed_owner(hwnd: HWND) {
        SHORTCUT_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            registry.owners.remove(&hwnd_key(hwnd));
            if registry.owners.is_empty() {
                if let Some(hook) = registry.keyboard_hook.take() {
                    // SAFETY: the hook was installed by this registry on this
                    // UI thread and retires with its final exact HWND.
                    let _ = unsafe { UnhookWindowsHookEx(hook) };
                }
                if let Some(hook) = registry.mouse_hook.take() {
                    let _ = unsafe { UnhookWindowsHookEx(hook) };
                }
            }
        });
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
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if code != HC_ACTION as i32 {
                return;
            }
            // SAFETY: WH_KEYBOARD_LL supplies a valid KBDLLHOOKSTRUCT pointer
            // for HC_ACTION and retains it for the duration of this callback.
            let keyboard = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            SHORTCUT_REGISTRY.with(|registry| {
                let mut registry = registry.borrow_mut();
                registry.hook_callbacks = registry.hook_callbacks.saturating_add(1);
                // SAFETY: this hook reads only the exact current foreground
                // HWND and never enumerates or guesses Chromium HWNDs.
                let foreground = unsafe { GetForegroundWindow() };
                let Some(owner) = registry.owners.get_mut(&hwnd_key(foreground)) else {
                    return;
                };
                owner.foreground_matches = owner.foreground_matches.saturating_add(1);
                let released = keyboard.flags.contains(LLKHF_UP)
                    || (wparam.0 != WM_KEYDOWN as usize && wparam.0 != WM_SYSKEYDOWN as usize);
                owner.record_key(
                    keyboard.vkCode,
                    keyboard.scanCode,
                    keyboard.flags.0,
                    released,
                );
                owner.physical_input_sequence = owner.physical_input_sequence.saturating_add(1);
            });
        }));
        // SAFETY: physical keyboard input is evidence only. Every key continues
        // through the current thread's hook chain; application shortcuts are
        // owned above page delivery by Chromium's before-input-event owners.
        // Passing None is documented for this operation.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    unsafe extern "system" fn runtime_low_level_mouse_hook(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if code != HC_ACTION as i32 {
                return;
            }
            // SAFETY: WH_MOUSE_LL supplies this structure for HC_ACTION and
            // retains it through the callback.
            let mouse = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            // MSLLHOOKSTRUCT.flags is a bare u32 bitfield, unlike the keyboard
            // hook's KBDLLHOOKSTRUCT_FLAGS newtype, so this masks directly.
            if mouse.flags & LLMHF_INJECTED != 0 {
                return;
            }
            let projected = match wparam.0 as u32 {
                WM_LBUTTONDOWN | WM_MBUTTONDOWN | WM_RBUTTONDOWN => 1,
                WM_LBUTTONUP | WM_MBUTTONUP => 2,
                WM_RBUTTONUP => 3,
                _ => 0,
            };
            if projected == 0 {
                return;
            }
            // SAFETY: the exact current foreground HWND is the sole registry
            // key. The hook never consumes or redirects player input.
            let foreground = unsafe { GetForegroundWindow() };
            SHORTCUT_REGISTRY.with(|registry| {
                if let Some(owner) = registry.borrow_mut().owners.get_mut(&hwnd_key(foreground)) {
                    owner.physical_input_sequence =
                        owner.physical_input_sequence.saturating_add(projected);
                }
            });
        }));
        // SAFETY: physical mouse input is evidence only and always continues.
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

    pub(super) fn register(parent: HWND, owner_revision: u64) -> Result<u32> {
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

            let installed_hooks = if registry.keyboard_hook.is_none() {
                let module = hook_module()?;
                // SAFETY: WH_KEYBOARD_LL is desktop-scoped but owned by
                // Electron's message-loop thread. The static callback forwards
                // every key and only records evidence while an exact registered
                // Rion runtime HWND is foreground, retains no unrelated input,
                // and remains valid while the rion_node module is loaded.
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
                let mouse_hook = unsafe {
                    SetWindowsHookExW(
                        WH_MOUSE_LL,
                        Some(runtime_low_level_mouse_hook),
                        Some(module),
                        0,
                    )
                }
                .map_err(|_| {
                    let _ = unsafe { UnhookWindowsHookEx(hook) };
                    probe_error(
                        Status::GenericFailure,
                        "Win32 could not install the runtime physical mouse evidence owner.",
                    )
                })?;
                registry.keyboard_hook = Some(hook);
                registry.mouse_hook = Some(mouse_hook);
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
                if installed_hooks {
                    if let Some(hook) = registry.keyboard_hook.take() {
                        let _ = unsafe { UnhookWindowsHookEx(hook) };
                    }
                    if let Some(hook) = registry.mouse_hook.take() {
                        let _ = unsafe { UnhookWindowsHookEx(hook) };
                    }
                }
                return Err(probe_error(
                    Status::GenericFailure,
                    "Win32 could not bind runtime shortcut teardown to the exact HWND.",
                ));
            }

            registry.owners.insert(
                key,
                ShortcutOwner {
                    foreground_matches: 0,
                    owner_revision,
                    physical_input_sequence: 0,
                    physical_keyboard_sequence: 0,
                    physical_key_events: std::collections::VecDeque::new(),
                    physical_held_codes: std::collections::HashSet::new(),
                },
            );
            Ok(ui_thread_id)
        })
    }

    pub(super) fn unregister(parent: HWND, owner_revision: u64) -> Result<bool> {
        SHORTCUT_REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            let key = hwnd_key(parent);
            let Some(owner) = registry.owners.get(&key) else {
                return Ok(false);
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
            registry.owners.remove(&key);
            if registry.owners.is_empty() {
                for hook in [registry.keyboard_hook.take(), registry.mouse_hook.take()]
                    .into_iter()
                    .flatten()
                {
                    // SAFETY: this is the current thread's registry-owned hook.
                    unsafe { UnhookWindowsHookEx(hook) }.map_err(|_| {
                        probe_error(
                            Status::GenericFailure,
                            "Win32 could not remove the runtime physical-input owner.",
                        )
                    })?;
                }
            }
            Ok(true)
        })
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
                hook_callbacks: registry.hook_callbacks,
                foreground_matches: owner.foreground_matches,
            })
        })
    }

    pub(super) fn physical_keyboard_evidence(
        parent: HWND,
    ) -> Result<super::PhysicalKeyboardEvidence> {
        validate_parent(parent)?;
        SHORTCUT_REGISTRY.with(|registry| {
            let registry = registry.borrow();
            let owner = registry.owners.get(&hwnd_key(parent)).ok_or_else(|| {
                probe_error(
                    Status::InvalidArg,
                    "The Windows keyboard evidence owner is missing.",
                )
            })?;
            Ok(super::PhysicalKeyboardEvidence {
                sequence: owner.physical_keyboard_sequence.to_string(),
                events: owner.physical_key_events.iter().cloned().collect(),
            })
        })
    }

    pub(super) fn physical_input_sequence(parent: HWND) -> Result<u64> {
        validate_parent(parent)?;
        SHORTCUT_REGISTRY.with(|registry| {
            registry
                .borrow()
                .owners
                .get(&hwnd_key(parent))
                .map(|owner| owner.physical_input_sequence)
                .ok_or_else(|| {
                    probe_error(
                        Status::InvalidArg,
                        "The Windows runtime HWND has no physical-input evidence owner.",
                    )
                })
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
) -> Result<WindowsRuntimeShortcutOwnerReceipt> {
    let parent_address = parse_electron_native_handle(&parent_handle, "parent")?;
    let parsed_revision = parse_owner_revision(&owner_revision)?;
    let ui_thread_id = platform::register(platform::hwnd(parent_address), parsed_revision)?;
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
#[napi(js_name = "readWindowsPhysicalInputSequence")]
pub fn read_windows_physical_input_sequence(parent_handle: Buffer) -> Result<String> {
    let parent_address = parse_electron_native_handle(&parent_handle, "parent")?;
    Ok(platform::physical_input_sequence(platform::hwnd(parent_address))?.to_string())
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
#[napi(js_name = "readWindowsPhysicalInputSequence")]
pub fn read_windows_physical_input_sequence(_parent_handle: Buffer) -> Result<String> {
    Err(probe_error(
        Status::GenericFailure,
        "The Win32 physical-input evidence owner is available only on Windows.",
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
    fn f11_is_an_ordinary_physical_key_for_this_owner() {
        // The owner journals F11 like any other key; it never captures or
        // dispatches it. Chromium's before-input-event owners hold the
        // application shortcut above page delivery.
        assert_eq!(
            crate::physical_key_evidence::windows_key_code(0x7a, 0x57, false),
            "F11"
        );
    }
}

#[napi(js_name = "readWindowsPhysicalKeyboardEvidence")]
pub fn read_windows_physical_keyboard_evidence(
    parent_handle: Buffer,
) -> Result<PhysicalKeyboardEvidence> {
    #[cfg(windows)]
    {
        let address = parse_electron_native_handle(&parent_handle, "parent")?;
        platform::physical_keyboard_evidence(platform::hwnd(address))
    }
    #[cfg(not(windows))]
    {
        let _ = parent_handle;
        Err(probe_error(
            Status::GenericFailure,
            "Windows keyboard evidence is unavailable on this platform.",
        ))
    }
}
