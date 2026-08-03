impl SystemRuntimeExecutor {
    fn window_zoom_indicator_label(&self, zoom_factor: f64) -> String {
        let percent = (zoom_factor * 100.0).round() as u32;
        let language = self
            .language
            .lock()
            .map(|language| language.clone())
            .unwrap_or_else(|_| "en".to_owned());
        match language.as_str() {
            "zh-TW" => format!("窗口 {percent}%"),
            "zh-CN" => format!("窗口 {percent}%"),
            "ja" => format!("ウインドウ {percent}%"),
            _ => format!("Window {percent}%"),
        }
    }

    pub fn execute(
        &self,
        effect: CoreEffectRequest,
        presentation_revision: u64,
    ) -> CoreEffectResult {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        match self.apply(effect, presentation_revision) {
            Ok(value_json) => CoreEffectResult {
                effect_id,
                operation_id,
                ok: true,
                value_json,
                error: None,
            },
            Err(error) => CoreEffectResult {
                effect_id,
                operation_id,
                ok: false,
                value_json: None,
                error: Some(rion_core::CoreErrorPayload {
                    code: error.code.to_owned(),
                    message: error.message,
                }),
            },
        }
    }

    pub fn projection(&self, snapshot: &BrowserRuntimeSnapshot) -> Value {
        let role_names = self
            .core
            .invoke(CoreCommand::RolesList)
            .ok()
            .and_then(|value| serde_json::from_value::<Vec<StateRoleRecord>>(value).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|role| (role.id, role.name))
            .collect::<HashMap<_, _>>();
        let selected_tabs = self.presentation.selected_tabs();
        let (tabs, window_inputs, saved_windows, recovery) = {
            let Ok(state) = self.state.lock() else {
                return json!({ "windows": [], "tabs": [] });
            };
            let tabs = snapshot
                .tabs
                .iter()
                .map(|tab| {
                    // The native visibility transaction is the earliest committed source for
                    // the tab the user can actually see. It intentionally leads the core
                    // snapshot while a launch navigation or another effect is still pending.
                    let active = selected_tabs
                        .get(&tab.window_id)
                        .is_some_and(|selected| selected == &tab.id);
                    let audio_muted = state
                        .tabs
                        .get(&tab.id)
                        .is_some_and(|runtime_tab| runtime_tab.audio_muted);
                    let audible = state
                        .tabs
                        .get(&tab.id)
                        .is_some_and(|runtime_tab| runtime_tab_is_audible(&state, runtime_tab));
                    json!({
                        "id": tab.id,
                        "type": if tab.tab_type == "workspace" { "workspace" } else { "role" },
                        "sourceId": tab.source_id,
                        "name": tab.name,
                        "windowId": tab.window_id,
                        "roleIds": tab.role_ids,
                        "roleNames": tab.role_ids.iter().filter_map(|role_id| role_names.get(role_id).cloned()).collect::<Vec<_>>(),
                        "hidden": tab.hidden || state.optimistic_closed_tabs.contains(&tab.id),
                        "active": active,
                        "audible": audible,
                        "audioMuted": audio_muted
                    })
                })
                .collect::<Vec<_>>();
            let window_inputs = snapshot
                .windows
                .iter()
                .filter_map(|runtime_window| {
                    let host = state.display_hosts.get(&runtime_window.window_id)?;
                    let presented_active_tab_id = selected_tabs
                        .get(&runtime_window.window_id)
                        .filter(|tab_id| !state.optimistic_closed_tabs.contains(tab_id.as_str()))
                        .cloned()
                        .or_else(|| {
                            runtime_window
                                .active_tab_id
                                .as_ref()
                                .filter(|tab_id| {
                                    !state.optimistic_closed_tabs.contains(tab_id.as_str())
                                })
                                .cloned()
                        });
                    Some((
                        host.window.label().to_owned(),
                        runtime_window.window_id.clone(),
                        host.target.display_id,
                        host.target.work_area.clone(),
                        host.window.clone(),
                        presented_active_tab_id,
                        runtime_window.tab_ids.len(),
                    ))
                })
                .collect::<Vec<_>>();
            let saved_windows = state
                .dormant_windows
                .iter()
                .map(|window| {
                    let display_label = window
                        .target_display
                        .fingerprint
                        .as_ref()
                        .map(|fingerprint| fingerprint.label.trim())
                        .filter(|label| !label.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("Display {}", window.target_display.id));
                    let role_count = window
                        .tabs
                        .iter()
                        .flat_map(|tab| tab.role_ids.iter())
                        .collect::<HashSet<_>>()
                        .len();
                    json!({
                        "id": window.id,
                        "displayId": window.target_display.id,
                        "displayLabel": display_label,
                        "wasVisible": window.was_visible,
                        "activeSourceId": window.active_source_id,
                        "tabCount": window.tabs.len(),
                        "roleCount": role_count,
                        "tabNames": window.tabs.iter().map(|tab| tab.name.clone()).collect::<Vec<_>>(),
                        "state": "saved"
                    })
                })
                .collect::<Vec<_>>();
            let recovery = state.recovery_required.then(|| {
                json!({
                    "reason": "unclean-exit",
                    "windowCount": saved_windows.len(),
                    "tabCount": state.dormant_windows.iter().map(|window| window.tabs.len()).sum::<usize>()
                })
            });
            (tabs, window_inputs, saved_windows, recovery)
        };
        let windows = window_inputs
            .into_iter()
            .map(
                |(_label, window_id, display_id, bounds, window, tab_id, tab_count)| {
                    json!({
                        "id": window_id,
                        "windowId": window_id,
                        "displayId": display_id,
                        "bounds": bounds,
                        "visible": window.is_visible().unwrap_or(false),
                        "focused": window.is_focused().unwrap_or(false),
                        "activeTabId": tab_id,
                        "tabCount": tab_count
                    })
                },
            )
            .collect::<Vec<_>>();
        json!({
            "windows": windows,
            "tabs": tabs,
            "savedWindows": saved_windows,
            "recovery": recovery
        })
    }

    pub fn begin_auto_restore(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.auto_restore_attempted
            || state.recovery_required
            || state.dormant_windows.is_empty()
        {
            return false;
        }
        state.auto_restore_attempted = true;
        true
    }

    pub fn recovery_required(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.recovery_required)
            .unwrap_or(false)
    }

    pub fn replace_dormant_windows(
        &self,
        windows: Vec<RuntimeRestoreWindowRecord>,
        recovery_required: bool,
    ) {
        if let Ok(mut state) = self.state.lock() {
            state.dormant_windows = windows;
            state.recovery_required = recovery_required && !state.dormant_windows.is_empty();
        }
        self.publish_projection();
    }

    pub fn publish_projection(&self) {
        let Ok(value) = self.core.invoke(CoreCommand::BrowserRuntimeSnapshot) else {
            return;
        };
        let Ok(snapshot) = serde_json::from_value::<BrowserRuntimeSnapshot>(value) else {
            return;
        };
        let snapshot = self.snapshot_with_native_tab_locations(snapshot);
        // Renderer projection and native tab metadata may lag presentation, but neither path
        // owns topology or selection. Insert/replace/remove/select are committed directly by
        // WindowPresentationState and therefore never wait for Core or a game page.
        #[cfg(target_os = "macos")]
        self.sync_native_tab_metadata(&snapshot);
        #[cfg(windows)]
        self.sync_windows_tab_metadata(&snapshot);
        self.publish_launcher_presence();
        let _ = self
            .app
            .emit("rion://runtime-state", self.projection(&snapshot));
    }

    /// Commits selection immediately and coalesces native visibility work by window revision.
    /// Page readiness is intentionally absent from this path.
    pub(crate) fn preview_tab_activation(
        &self,
        tab_id: &str,
        native_style_applied: bool,
    ) -> Result<(String, bool, String), String> {
        let trigger = if native_style_applied {
            "native-pointer"
        } else {
            "pointer"
        };
        self.preview_tab_activation_with_focus(
            tab_id,
            NativePresentationFocus::ContentOnly,
            trigger,
            None,
        )
    }

    pub(crate) fn preview_launcher_tab_activation(
        &self,
        tab_id: &str,
    ) -> Result<(String, bool, String), String> {
        self.preview_tab_activation_with_focus(
            tab_id,
            NativePresentationFocus::WindowAndContent,
            "launcher-external",
            Some(true),
        )
    }

    fn preview_tab_activation_with_focus(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
    ) -> Result<(String, bool, String), String> {
        let resolved_tab_id = self
            .presentation
            .resolve_tab_alias(tab_id)
            .unwrap_or_else(|| tab_id.to_owned());
        if let Some(window_id) =
            self.request_provisional_tab_presentation(
                &resolved_tab_id,
                focus,
                trigger,
                window_visibility,
            )?
        {
            return Ok((window_id, true, resolved_tab_id));
        }
        self.request_tab_presentation_with_window_visibility(
            &resolved_tab_id,
            focus,
            trigger,
            window_visibility,
        )
        .map(|(window_id, _)| (window_id, false, resolved_tab_id))
    }

    fn reconcile_presentation_tab_owner(
        &self,
        tab_id: &str,
        target_window_id: &str,
    ) -> Result<(), String> {
        let owner = self.presentation.tab_window(tab_id)?;
        let Some(source_window_id) = owner else {
            return Err("Runtime tab was not found in the presentation registry.".to_owned());
        };
        if source_window_id == target_window_id {
            return Ok(());
        }
        let revision = self.presentation.next_revision();
        self.presentation.move_tab_with_activation(
            tab_id,
            &source_window_id,
            target_window_id,
            revision,
            false,
        )?;
        self.record_topology_reconciled(tab_id, &source_window_id, target_window_id, revision);
        if self.window_for_id(&source_window_id).is_some() {
            self.reconcile_window_presentation(&source_window_id, "topology-self-healed")
                .map_err(|error| error.message)?;
        }
        Ok(())
    }

    fn request_provisional_tab_presentation(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
    ) -> Result<Option<String>, String> {
        let requested_at = Instant::now();
        let (window_id, window) = {
            let state = self.state().map_err(|error| error.message)?;
            let provisional = state
                .provisional_launches
                .values()
                .find(|launch| launch.id == tab_id && !launch.cancelled)
                .cloned();
            let Some(provisional) = provisional else {
                return Ok(None);
            };
            let window_id = provisional.window_id;
            let window = state
                .display_hosts
                .get(&window_id)
                .ok_or_else(|| "Runtime display host was not found.".to_owned())?
                .window
                .clone();
            (window_id, window)
        };
        let (previous_tab_id, previous_surfaces, revision) = {
            let presentation = self.presentation.coordinator(&window_id)?;
            let revision = self.presentation.next_revision();
            let mut window_state = presentation.lock().map_err(|_| {
                "The runtime tab presentation coordinator is unavailable.".to_owned()
            })?;
            if !window_state.contains_tab(tab_id) {
                return Ok(None);
            }
            let previous_tab_id = window_state.selected_tab_id.clone();
            let previous_surfaces = window_state.surfaces(previous_tab_id.as_deref());
            window_state.select(Some(tab_id.to_owned()), revision);
            (previous_tab_id, previous_surfaces, revision)
        };
        if matches!(trigger, "native-pointer" | "shortcut") {
            self.remember_native_active_style(&window_id, Some(tab_id));
        } else if trigger != "surface-attached" {
            self.apply_native_active_style(&window_id, Some(tab_id), revision, trigger);
        }
        self.dispatch_native_presentation(
            window_id.clone(),
            Some(tab_id.to_owned()),
            revision,
            trigger,
            requested_at,
            window,
            previous_tab_id,
            previous_surfaces,
            Vec::new(),
            None,
            window_visibility,
            focus,
            None,
        );
        Ok(Some(window_id))
    }

    fn request_tab_presentation(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
    ) -> Result<(String, u64), String> {
        self.request_tab_presentation_with_window_visibility(tab_id, focus, trigger, None)
    }

    fn request_window_contract_presentation(
        &self,
        window_id: &str,
        tab_id: Option<&str>,
        window_visibility: Option<bool>,
        focus: NativePresentationFocus,
        window_mode: Option<NativeWindowMode>,
        trigger: &'static str,
    ) -> RuntimeResult<u64> {
        self.mark_critical_activity();
        let window = {
            let state = self.state()?;
            state
                .display_hosts
                .get(window_id)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "Runtime display host was not found.",
                    )
                })?
                .window
                .clone()
        };
        let coordinator = self
            .presentation
            .coordinator(window_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        let revision = self.presentation.next_revision();
        let (previous_tab_id, previous_surfaces, next_surfaces, active_webview) = {
            let mut state = coordinator.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            if let Some(tab_id) = tab_id
                && !state.contains_tab(tab_id)
            {
                return Err(RuntimeError::new(
                    "TAURI_RUNTIME_TAB_NOT_FOUND",
                    "Runtime tab was not found in the presentation state.",
                ));
            }
            let previous_tab_id = state.selected_tab_id.clone();
            let previous_surfaces = state.surfaces(previous_tab_id.as_deref());
            state.select(tab_id.map(str::to_owned), revision);
            let next_surfaces = state.surfaces(tab_id);
            let active_webview = next_surfaces.first().cloned();
            (
                previous_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
            )
        };
        self.apply_native_active_style(window_id, tab_id, revision, trigger);
        self.dispatch_native_presentation(
            window_id.to_owned(),
            tab_id.map(str::to_owned),
            revision,
            trigger,
            Instant::now(),
            window,
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            window_visibility,
            focus,
            window_mode,
        );
        Ok(revision)
    }

    fn request_tab_presentation_with_window_visibility(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
    ) -> Result<(String, u64), String> {
        self.mark_critical_activity();
        let requested_at = Instant::now();
        let (window_id, window) = {
            let state = self.state().map_err(|error| error.message)?;
            if state.optimistic_closed_tabs.contains(tab_id) {
                return Err("The runtime tab is closing.".to_owned());
            }
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
            let window_id = tab.window_id.clone();
            let window = state
                .display_hosts
                .get(&window_id)
                .ok_or_else(|| "Runtime display host was not found.".to_owned())?
                .window
                .clone();
            (window_id, window)
        };
        self.reconcile_presentation_tab_owner(tab_id, &window_id)?;
        let (previous_tab_id, previous_surfaces, next_surfaces, active_webview, revision) = {
            let presentation = self.presentation.coordinator(&window_id)?;
            let revision = self.presentation.next_revision();
            let mut window_state = presentation.lock().map_err(|_| {
                "The runtime tab presentation coordinator is unavailable.".to_owned()
            })?;
            if !window_state.contains_tab(tab_id) {
                return Err("Runtime tab was not found in the presentation state.".to_owned());
            }
            let previous_tab_id = window_state.selected_tab_id.clone();
            let previous_surfaces = window_state.surfaces(previous_tab_id.as_deref());
            let next_surfaces = window_state.surfaces(Some(tab_id));
            let active_webview = next_surfaces.first().cloned();
            window_state.select(Some(tab_id.to_owned()), revision);
            (
                previous_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                revision,
            )
        };
        if matches!(trigger, "native-pointer" | "shortcut") {
            self.remember_native_active_style(&window_id, Some(tab_id));
        } else if trigger != "surface-attached" {
            self.apply_native_active_style(&window_id, Some(tab_id), revision, trigger);
        }
        self.dispatch_native_presentation(
            window_id.clone(),
            Some(tab_id.to_owned()),
            revision,
            trigger,
            requested_at,
            window,
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            window_visibility,
            focus,
            None,
        );
        Ok((window_id, revision))
    }

    fn reconcile_window_presentation(
        &self,
        window_id: &str,
        trigger: &'static str,
    ) -> RuntimeResult<()> {
        let coordinator = self
            .presentation
            .coordinator(window_id)
            .map_err(|message| {
                RuntimeError::new("SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE", message)
            })?;
        let (tab_id, revision) = {
            let selection = coordinator.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            (selection.selected_tab_id.clone(), selection.revision)
        };
        if revision == 0 {
            return Ok(());
        }
        let window = {
            let state = self.state()?;
            state
                .display_hosts
                .get(window_id)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_DISPLAY_NOT_FOUND",
                        "Runtime display host was not found.",
                    )
                })?
                .window
                .clone()
        };
        let (next_surfaces, active_webview) = {
            let presentation = coordinator.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime tab presentation coordinator is unavailable.",
                )
            })?;
            let next_surfaces = presentation.surfaces(tab_id.as_deref());
            let active_webview = next_surfaces.first().cloned();
            (next_surfaces, active_webview)
        };
        self.apply_native_active_style(window_id, tab_id.as_deref(), revision, trigger);
        self.dispatch_native_presentation(
            window_id.to_owned(),
            tab_id,
            revision,
            trigger,
            Instant::now(),
            window,
            None,
            Vec::new(),
            next_surfaces,
            active_webview,
            None,
            NativePresentationFocus::None,
            None,
        );
        Ok(())
    }

    pub(crate) fn preview_adjacent_tab_activation(
        &self,
        window_id: &str,
        direction: &str,
    ) -> Result<(String, bool), String> {
        let (candidates, current_tab_id) = {
            let presentation = self.presentation.coordinator(window_id)?;
            let window = presentation.lock().map_err(|_| {
                "The runtime tab presentation coordinator is unavailable.".to_owned()
            })?;
            (window.tab_ids(), window.selected_tab_id.clone())
        };
        if candidates.is_empty() {
            return Err("The runtime window has no selectable tabs.".to_owned());
        }
        let current = current_tab_id
            .as_ref()
            .and_then(|active_id| candidates.iter().position(|tab_id| tab_id == active_id))
            .unwrap_or(0);
        let target_index = if direction == "previous" {
            (current + candidates.len() - 1) % candidates.len()
        } else {
            (current + 1) % candidates.len()
        };
        let target_id = candidates[target_index].clone();
        let provisional = self
            .request_provisional_tab_presentation(
                &target_id,
                NativePresentationFocus::ContentOnly,
                "shortcut",
                None,
            )?
            .is_some();
        if !provisional {
            self.request_tab_presentation(
                &target_id,
                NativePresentationFocus::ContentOnly,
                "shortcut",
            )?;
        }
        Ok((target_id, provisional))
    }

}
