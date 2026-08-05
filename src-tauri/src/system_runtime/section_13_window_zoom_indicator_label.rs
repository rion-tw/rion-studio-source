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

    fn projection_payload(&self, snapshot: &BrowserRuntimeSnapshot) -> Value {
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
                        "roleIds": tab.slots.iter().map(|slot| slot.role_id.clone()).collect::<Vec<_>>(),
                        "roleNames": tab.slots.iter().filter_map(|slot| role_names.get(&slot.role_id).cloned()).collect::<Vec<_>>(),
                        "slots": tab.slots,
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
                    "tabCount": state.dormant_windows.iter().map(|window| window.tabs.len()).sum::<usize>(),
                    "interruptedWindowIds": state.recovery_interrupted_window_ids,
                    "sessionGeneration": state.recovery_session_generation
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

    pub fn projection(&self, snapshot: &BrowserRuntimeSnapshot) -> Value {
        self.runtime_projection
            .resolve_object(self.projection_payload(snapshot))
    }

    pub(crate) fn live_projection(&self, snapshot: BrowserRuntimeSnapshot) -> Option<Value> {
        self.live_runtime_snapshot(snapshot)
            .map(|snapshot| self.projection(&snapshot))
    }

    pub(crate) fn live_runtime_snapshot(
        &self,
        snapshot: BrowserRuntimeSnapshot,
    ) -> Option<BrowserRuntimeSnapshot> {
        self.snapshot_with_live_tab_topology(snapshot)
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
            if !state.recovery_required {
                state.recovery_interrupted_window_ids.clear();
            }
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
        let Some(snapshot) = self.snapshot_with_live_tab_topology(snapshot) else {
            return;
        };
        // Renderer projection and native tab metadata may lag presentation, but neither path
        // owns topology or selection. Insert/replace/remove/select are committed directly by
        // LiveWindowTabState and therefore never wait for Core or a game page.
        #[cfg(target_os = "macos")]
        self.sync_native_tab_metadata(&snapshot);
        #[cfg(windows)]
        self.sync_windows_tab_metadata(&snapshot);
        #[cfg(windows)]
        self.sync_windows_tab_chrome_projections(&snapshot);
        self.publish_launcher_presence();
        let _ = self
            .app
            .emit("rion://runtime-state", self.projection(&snapshot));
    }

    /// Commits launcher selection without creating a transaction that a native menu callback
    /// must wait to converge. The visible presentation is authoritative; Core selection
    /// persistence is queued separately by the caller.
    pub(crate) fn preview_launcher_tab_activation_background(
        &self,
        tab_id: &str,
    ) -> Result<(String, bool, String, String), String> {
        let resolved_tab_id = self
            .presentation
            .resolve_tab_alias(tab_id)
            .unwrap_or_else(|| tab_id.to_owned());
        if let Some((window_id, operation_id)) = self
            .request_provisional_tab_presentation_with_transaction(
                &resolved_tab_id,
                NativePresentationFocus::WindowAndContent,
                "launcher-external",
                Some(true),
                false,
            )?
        {
            return Ok((window_id, true, resolved_tab_id, operation_id));
        }
        self.request_tab_presentation_with_window_visibility(
            &resolved_tab_id,
            NativePresentationFocus::WindowAndContent,
            "launcher-external",
            Some(true),
        )
        .map(|(window_id, _, operation_id)| {
            (window_id, false, resolved_tab_id, operation_id)
        })
    }

    fn resolve_live_presentation_tab_owner(
        &self,
        tab_id: &str,
    ) -> Result<String, String> {
        self.presentation
            .tab_window(tab_id)?
            .ok_or_else(|| "Runtime tab is no longer available for activation.".to_owned())
    }

    fn request_provisional_tab_activation(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
    ) -> Result<Option<(String, String)>, String> {
        self.request_provisional_tab_presentation_with_transaction(
            tab_id,
            focus,
            trigger,
            window_visibility,
            true,
        )
    }

    fn request_provisional_tab_presentation_with_transaction(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
        transactional: bool,
    ) -> Result<Option<(String, String)>, String> {
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
        let (previous_tab_id, previous_surfaces, ordered_tab_ids, revision) = {
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
            (
                previous_tab_id,
                previous_surfaces,
                window_state.tab_ids(),
                revision,
            )
        };
        let activation = transactional
            .then(|| self.accept_tab_activation(&window_id, tab_id, revision, trigger, false))
            .transpose()?;
        if let Some(activation) = activation.as_ref() {
            self.operations.mark_in_flight(&activation.operation_id);
            self.apply_tab_activation_chrome(activation, ordered_tab_ids);
        }
        if !transactional && matches!(trigger, "native-pointer" | "shortcut") {
            self.remember_native_active_style(&window_id, Some(tab_id));
        } else if !transactional && trigger != "surface-attached" {
            self.apply_native_active_style(&window_id, Some(tab_id), revision, trigger);
        }
        let presentation_operation_id = self.dispatch_native_presentation(
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
        let operation_id = if let Some(activation) = activation {
            self.track_tab_activation_presentation(
                activation.operation_id.clone(),
                presentation_operation_id,
            );
            activation.operation_id
        } else {
            presentation_operation_id
        };
        Ok(Some((window_id, operation_id)))
    }

    fn request_tab_presentation(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
    ) -> Result<(String, u64, String), String> {
        self.request_tab_presentation_with_window_visibility(tab_id, focus, trigger, None)
    }

    fn request_tab_activation_with_window_visibility(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
    ) -> Result<(String, u64, String), String> {
        self.request_tab_presentation_with_window_visibility_and_transaction(
            tab_id,
            focus,
            trigger,
            window_visibility,
            true,
        )
    }

    fn request_window_contract_presentation(
        &self,
        window_id: &str,
        tab_id: Option<&str>,
        window_visibility: Option<bool>,
        focus: NativePresentationFocus,
        window_mode: Option<NativeWindowMode>,
        trigger: &'static str,
    ) -> RuntimeResult<(u64, String)> {
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
        let operation_id = self.dispatch_native_presentation(
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
        Ok((revision, operation_id))
    }

    fn request_tab_presentation_with_window_visibility(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
    ) -> Result<(String, u64, String), String> {
        self.request_tab_presentation_with_window_visibility_and_transaction(
            tab_id,
            focus,
            trigger,
            window_visibility,
            false,
        )
    }

    fn request_tab_presentation_with_window_visibility_and_transaction(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
        transactional: bool,
    ) -> Result<(String, u64, String), String> {
        self.mark_critical_activity();
        let requested_at = Instant::now();
        let runtime_window_id = {
            let state = self.state().map_err(|error| error.message)?;
            if state.optimistic_closed_tabs.contains(tab_id) {
                return Err("The runtime tab is closing.".to_owned());
            }
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
            tab.window_id.clone()
        };
        let window_id = self.resolve_live_presentation_tab_owner(tab_id)?;
        let window = self
            .window_for_id(&window_id)
            .ok_or_else(|| "Runtime display host was not found.".to_owned())?;
        if runtime_window_id != window_id
            && let Some(runtime) = self
                .self_weak
                .get()
                .and_then(std::sync::Weak::upgrade)
        {
            runtime.schedule_tab_surface_move_retry(tab_id.to_owned(), window_id.clone());
        }
        let (
            previous_tab_id,
            previous_surfaces,
            next_surfaces,
            active_webview,
            ordered_tab_ids,
            revision,
            was_hidden,
            tab_presentation,
        ) = {
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
            let was_hidden = window_state.tab_is_hidden(tab_id);
            let tab_presentation = window_state
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .cloned()
                .ok_or_else(|| "Runtime tab presentation metadata was not found.".to_owned())?;
            window_state.select(Some(tab_id.to_owned()), revision);
            (
                previous_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                window_state.tab_ids(),
                revision,
                was_hidden,
                tab_presentation,
            )
        };
        if was_hidden {
            #[cfg(any(windows, target_os = "macos"))]
            let workspace_template = tab_presentation.workspace_template.as_deref();
            #[cfg(not(any(windows, target_os = "macos")))]
            let workspace_template: Option<&str> = None;
            if let Err(error) = self.try_ensure_native_tab(
                &window_id,
                tab_id,
                &tab_presentation.title,
                &tab_presentation.tab_type,
                workspace_template,
            ) {
                eprintln!(
                    "Unhidden native tab chrome remains pending without live rollback: tab={tab_id} window={window_id} error={}",
                    error.message
                );
            }
            if let Err(error) = self.reorder_native_tabs(&window_id, &ordered_tab_ids) {
                eprintln!(
                    "Unhidden native tab order remains pending without live rollback: tab={tab_id} window={window_id} error={}",
                    error.message
                );
            }
            self.schedule_live_window_state_persistence(&window_id);
        }
        let activation = transactional
            .then(|| self.accept_tab_activation(&window_id, tab_id, revision, trigger, true))
            .transpose()?;
        if let Some(activation) = activation.as_ref() {
            self.operations.mark_in_flight(&activation.operation_id);
            self.apply_tab_activation_chrome(activation, ordered_tab_ids);
        }
        if !transactional && matches!(trigger, "native-pointer" | "shortcut") {
            self.remember_native_active_style(&window_id, Some(tab_id));
        } else if !transactional && trigger != "surface-attached" {
            self.apply_native_active_style(&window_id, Some(tab_id), revision, trigger);
        }
        let presentation_operation_id = self.dispatch_native_presentation(
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
        let operation_id = if let Some(activation) = activation {
            self.track_tab_activation_presentation(
                activation.operation_id.clone(),
                presentation_operation_id,
            );
            activation.operation_id
        } else {
            presentation_operation_id
        };
        Ok((window_id, revision, operation_id))
    }

    pub(crate) fn preview_adjacent_tab_activation(
        &self,
        window_id: &str,
        direction: &str,
    ) -> Result<(String, bool, String), String> {
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
            .request_provisional_tab_activation(
                &target_id,
                NativePresentationFocus::ContentOnly,
                "shortcut",
                None,
            )?;
        let (provisional, operation_id) = if let Some((_, operation_id)) = provisional {
            (true, operation_id)
        } else {
            let (_, _, operation_id) = self.request_tab_activation_with_window_visibility(
                &target_id,
                NativePresentationFocus::ContentOnly,
                "shortcut",
                None,
            )?;
            (false, operation_id)
        };
        Ok((target_id, provisional, operation_id))
    }

}
