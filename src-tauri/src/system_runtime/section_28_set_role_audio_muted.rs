impl SystemRuntimeExecutor {
    fn apply_tab_audio_muted_effect(
        &self,
        tab_id: &str,
        window_id: &str,
        attempt_generation: &str,
        roles: &[EmbeddedTabAudioMuteRoleEffectRecord],
        muted: bool,
        previous_muted: bool,
    ) -> RuntimeResult<()> {
        let live_window_id = self.presentation.tab_window(tab_id).map_err(|message| {
            RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
        })?;
        let role_id = {
            let state = self.state()?;
            if state.launch_attempt_generations.get(tab_id).map(String::as_str)
                != Some(attempt_generation)
                || live_window_id.as_deref() != Some(window_id)
            {
                return Err(RuntimeError::new(
                    "RUNTIME_TAB_AUDIO_STALE",
                    "The runtime tab identity changed before native audio mute was applied.",
                ));
            }
            let tab = state.native_resources.tabs.get(tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            if roles.is_empty()
                || tab.roles.len() != roles.len()
                || roles.iter().any(|role| {
                    tab.roles
                        .get(&role.role_id)
                        .is_none_or(|surface| surface.generation != role.owner_generation)
                })
            {
                return Err(RuntimeError::new(
                    "RUNTIME_TAB_AUDIO_STALE",
                    "The runtime role generation set changed before native audio mute was applied.",
                ));
            }
            roles[0].role_id.clone()
        };
        self.apply_role_audio_muted(&role_id, muted, previous_muted)
    }

    fn apply_role_audio_muted(
        &self,
        role_id: &str,
        muted: bool,
        previous_muted: bool,
    ) -> RuntimeResult<()> {
        let (webviews, popup_labels) = {
            let state = self.state()?;
            let tab_id = state.native_tab_id_for_role_surface(role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })?;
            let tab = state.native_resources.tabs.get(&tab_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.")
            })?;
            let tab_role_ids = tab.roles.keys().cloned().collect::<HashSet<_>>();
            let webviews = tab
                .roles
                .values()
                .map(|role| role.webview.clone())
                .collect::<Vec<_>>();
            let popup_labels = state
                .popup_roles
                .iter()
                .filter(|(_, popup_role_id)| tab_role_ids.contains(*popup_role_id))
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            (webviews, popup_labels)
        };
        let mut all_webviews = webviews;
        for label in popup_labels {
            let webview = self.app.get_webview(&label).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_POPUP_HANDLE_MISSING",
                    format!("Runtime popup {label} has no live native handle."),
                )
            })?;
            all_webviews.push(webview);
        }
        if let Err(failure) = apply_reversible_fanout(
            &all_webviews,
            |index, webview| {
                set_audio_muted(webview, muted)
                    .map_err(|error| format!("surface {index}: {}", error.message))
            },
            |index, webview| {
                set_audio_muted(webview, previous_muted)
                    .map_err(|error| format!("surface {index}: {}", error.message))
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_AUDIO_MUTE_FAILED",
                "Updating runtime tab audio mute",
                &failure,
            ));
        }
        Ok(())
    }

    pub(crate) fn role_webview(&self, role_id: &str) -> RuntimeResult<Webview> {
        let state = self.state()?;
        let tab_id = state.native_tab_id_for_role_surface(role_id).ok_or_else(|| {
            RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "Runtime role was not found.",
            )
        })?;
        state.native_resources.tabs[tab_id]
            .roles
            .get(role_id)
            .map(|role| role.webview.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found.",
                )
            })
    }

    fn require_roles(&self, role_ids: &[String]) -> RuntimeResult<()> {
        let state = self.state()?;
        if role_ids
            .iter()
            .all(|role_id| state.has_native_role_surface(role_id))
        {
            Ok(())
        } else {
            Err(RuntimeError::new(
                "TAURI_RUNTIME_ROLE_NOT_FOUND",
                "A runtime role was not found.",
            ))
        }
    }

    fn state(&self) -> RuntimeResult<std::sync::MutexGuard<'_, RuntimeState>> {
        self.state.lock().map_err(|_| {
            RuntimeError::new(
                "TAURI_RUNTIME_STATE_FAILED",
                "System runtime state lock poisoned.",
            )
        })
    }

}
impl Drop for SystemRuntimeExecutor {
    fn drop(&mut self) {
        let _ = self.close_all();
        let pending_operation_ids = self
            .core
            .runtime_kernel()
            .snapshot()
            .map(|snapshot| {
                snapshot
                    .operations
                    .into_values()
                    .filter(|operation| operation.phase == RuntimeOperationPhase::Pending)
                    .map(|operation| operation.operation_id.into_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !pending_operation_ids.is_empty() {
            let _ = self.fail_runtime_event_stream(
                &uuid::Uuid::new_v4().to_string(),
                &pending_operation_ids,
                "NATIVE_EVENT_STREAM_STOPPED",
            );
        }
    }
}

fn handle_browser_download(
    app: &AppHandle,
    role_id: Option<&str>,
    event: DownloadEvent<'_>,
) -> bool {
    let (payload, allowed) = match event {
        DownloadEvent::Requested { url, .. } => (
            json!({
                "state": "blocked",
                "roleId": role_id,
                "url": url
            }),
            false,
        ),
        DownloadEvent::Finished { url, path, success } => (
            json!({
                "state": if success { "completed" } else { "failed" },
                "roleId": role_id,
                "url": url,
                "path": path.map(|path| path.to_string_lossy().into_owned())
            }),
            true,
        ),
        _ => return false,
    };
    let _ = app.emit("rion://browser-download", payload);
    allowed
}

fn evaluate_system_webview(webview: &Webview, source: &str) -> RuntimeResult<String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .eval_with_callback(source, move |value| {
            let _ = sender.send(value);
        })
        .map_err(RuntimeError::tauri)?;
    receiver.recv_timeout(Duration::from_secs(30)).map_err(|_| {
        RuntimeError::new(
            "TAURI_EVALUATION_TIMEOUT",
            "System WebView JavaScript evaluation timed out.",
        )
    })
}

fn surface_host_initialization_requires_visible_parent(platform: &str) -> bool {
    platform == "windows"
}

#[cfg(windows)]
fn windows_runtime_window_cloaked_status(window: &Window) -> RuntimeResult<u32> {
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?;
    let mut value = 0_u32;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            std::ptr::from_mut(&mut value).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    }
    .map_err(RuntimeError::tauri)?;
    Ok(value)
}

#[cfg(windows)]
fn set_windows_runtime_window_cloaked(window: &Window, cloaked: bool) -> RuntimeResult<()> {
    use windows::{
        Win32::Graphics::Dwm::{DWMWA_CLOAK, DwmSetWindowAttribute},
        core::BOOL,
    };

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?;
    let value = BOOL::from(cloaked);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            std::ptr::from_ref(&value).cast(),
            std::mem::size_of::<BOOL>() as u32,
        )
    }
    .map_err(RuntimeError::tauri)?;

    let observed = windows_runtime_window_cloaked_status(window)?;
    if (observed != 0) != cloaked {
        return Err(RuntimeError::new(
            "WINDOWS_RUNTIME_WINDOW_CLOAK_STATE_MISMATCH",
            format!(
                "DWM did not apply the requested runtime window cloak state (requested={cloaked}, observedMask=0x{observed:x})."
            ),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn register_windows_runtime_window_with_taskbar(window: &Window) -> RuntimeResult<()> {
    use windows::Win32::{
        System::Com::{CLSCTX_SERVER, CoCreateInstance},
        UI::Shell::{ITaskbarList, TaskbarList},
    };

    let hwnd = window.hwnd().map_err(RuntimeError::tauri)?;
    let taskbar: ITaskbarList = unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_SERVER) }
        .map_err(RuntimeError::tauri)?;
    unsafe { taskbar.AddTab(hwnd) }.map_err(RuntimeError::tauri)
}

#[cfg(windows)]
fn set_windows_surface_host_initialization_visibility(
    window: &Window,
    visible: bool,
) -> RuntimeResult<()> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let callback_window = window.clone();
    window
        .run_on_main_thread(move || {
            use windows::Win32::UI::WindowsAndMessaging::{
                SW_HIDE, SW_SHOWNOACTIVATE, ShowWindow,
            };
            let result = callback_window
                .hwnd()
                .map_err(|error| error.to_string())
                .map(|hwnd| {
                    let command = if visible { SW_SHOWNOACTIVATE } else { SW_HIDE };
                    let _ = unsafe { ShowWindow(hwnd, command) };
                });
            let _ = sender.send(result);
        })
        .map_err(RuntimeError::tauri)?;
    let result = receiver
        .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
        .map_err(|error| {
            let action = if visible { "show" } else { "hide" };
            RuntimeError::new(
                "SYSTEM_WEBVIEW_CREATION_STALLED",
                format!(
                    "The Windows WebView2 parent window did not {action} within {}ms ({error}). Restart Rion Studio before launching another browser role.",
                    PLATFORM_CALLBACK_TIMEOUT.as_millis()
                ),
            )
        })?;
    result.map_err(|error| {
        let action = if visible { "show" } else { "hide" };
        RuntimeError::new(
            "TAURI_RUNTIME_VISIBILITY_FAILED",
            format!("The Windows WebView2 parent window could not {action}: {error}"),
        )
    })
}

struct SessionPaths {
    webkit_identifier: [u8; 16],
    webview2: PathBuf,
}
