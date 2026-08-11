impl SystemRuntimeExecutor {
    pub(crate) fn refresh_projection_metadata(&self) -> Result<(), String> {
        let snapshot = self.core.app_snapshot().map_err(|error| error.to_string())?;
        let mut metadata = self
            .projection_metadata
            .write()
            .map_err(|_| "Runtime projection metadata lock poisoned.".to_owned())?;
        *metadata = RuntimeProjectionMetadata::from_app_snapshot(&snapshot);
        Ok(())
    }

    fn projection_metadata(&self) -> RuntimeProjectionMetadata {
        self.projection_metadata
            .read()
            .map(|metadata| metadata.clone())
            .unwrap_or_else(|_| RuntimeProjectionMetadata {
                games: Vec::new(),
                roles: Vec::new(),
                window_preferences: RuntimeWindowPreferencesRecord {
                    always_hide_tab_close_button: false,
                    always_show_toolbar_in_full_screen: false,
                    restore_game_windows_on_startup: true,
                },
            })
    }

    fn runtime_window_zoom_factor(&self, window_id: &str) -> f64 {
        self.presentation
            .existing(window_id)
            .and_then(|window| window.window_zoom_factor)
            .unwrap_or(1.0)
    }

    fn runtime_role_zoom_contract(
        &self,
        window_id: &str,
        tab_id: &str,
        role_id: &str,
        adaptive_projection: f64,
    ) -> (f64, bool) {
        let fixed = self
            .presentation
            .tab(window_id, tab_id)
            .and_then(|tab| {
                tab.role_slots
                    .iter()
                    .find(|slot| slot.role_id == role_id)
                    .and_then(|slot| slot.browser_zoom_percent)
            })
            .map(|percent| (percent / 100.0).clamp(0.25, 5.0));
        (fixed.unwrap_or(adaptive_projection.clamp(0.25, 5.0)), fixed.is_none())
    }

    pub(crate) fn superseded_tab_activation_summary(
        &self,
        tab_id: &str,
    ) -> SystemRuntimeOperationSummaryRecord {
        NativeOperationReceipt::with_status(
            NativeOperationContext::new(
                NativeOperationSubsystem::TabActivation,
                "tab-activation-stale-callback",
                Duration::ZERO,
            )
            .with_completion_scope(SystemRuntimeOperationCompletionScope::TopologyCommitted)
            .with_lifecycle_epoch(self.lifecycle_epoch())
            .with_revision(self.presentation.current_revision())
            .with_tab(tab_id),
            "tabActivationSuperseded",
            NativeOperationStatus::Superseded,
            None,
        )
        .summary()
    }

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

    async fn execute_event_bound_close(
        &self,
        effect: CoreEffectRequest,
        presentation_revision: u64,
    ) -> CoreEffectResult {
        let effect_id = effect.effect_id.clone();
        let operation_id = effect.operation_id.clone();
        match self
            .apply_event_bound_close(effect, presentation_revision)
            .await
        {
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
            .projection_metadata()
            .roles
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
                    let audio_muted = self
                        .presentation
                        .tab(&tab.window_id, &tab.id)
                        .is_some_and(|live_tab| live_tab.audio_muted);
                    let audible = state
                        .native_resources.tabs
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
                        "hidden": tab.hidden || state.tab_close_pending(&tab.id),
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
                    let host = state.native_resources.display_hosts.get(&runtime_window.window_id)?;
                    let presented_active_tab_id = selected_tabs
                        .get(&runtime_window.window_id)
                        .filter(|tab_id| !state.tab_close_pending(tab_id.as_str()))
                        .cloned()
                        .or_else(|| {
                            runtime_window
                                .active_tab_id
                                .as_ref()
                                .filter(|tab_id| {
                                    !state.tab_close_pending(tab_id.as_str())
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
                    let dormant_state = state
                        .dormant_window_states
                        .get(&window.id)
                        .cloned()
                        .unwrap_or_else(|| {
                            if state.recovery_required {
                                DormantWindowState::AwaitingRecovery
                            } else {
                                DormantWindowState::Dormant
                            }
                        });
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
                    let mut summary = json!({
                        "id": window.id,
                        "displayId": window.target_display.id,
                        "displayLabel": display_label,
                        "wasVisible": window.was_visible,
                        "activeSourceId": window.active_source_id,
                        "tabCount": window.tabs.len(),
                        "roleCount": role_count,
                        "tabNames": window.tabs.iter().map(|tab| tab.name.clone()).collect::<Vec<_>>(),
                        "state": dormant_state.as_str()
                    });
                    if let Some(message) = dormant_state.failure_message() {
                        summary["failureMessage"] = json!(message);
                    }
                    summary
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
        self.compose_live_runtime_snapshot(snapshot.roles)
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
            replace_dormant_window_state(&mut state, windows, recovery_required);
        }
        self.publish_projection();
    }

    pub fn begin_dormant_window_restore(&self, window_ids: &[String]) {
        let changed = if let Ok(mut state) = self.state.lock() {
            begin_dormant_window_restore_state(&mut state, window_ids)
        } else {
            false
        };
        if changed {
            self.publish_projection();
        }
    }

    pub fn finish_dormant_window_restore(
        &self,
        windows: Vec<RuntimeRestoreWindowRecord>,
        recovery_required: bool,
        failures: &HashMap<String, String>,
    ) {
        if let Ok(mut state) = self.state.lock() {
            finish_dormant_window_restore_state(
                &mut state,
                windows,
                recovery_required,
                failures,
            );
        }
        self.publish_projection();
    }

    pub fn fail_dormant_window_restores(&self, window_ids: &[String], message: &str) {
        let changed = if let Ok(mut state) = self.state.lock() {
            fail_dormant_window_restore_state(&mut state, window_ids, message)
        } else {
            false
        };
        if changed {
            self.publish_projection();
        }
    }

    pub(crate) fn dormant_windows(&self) -> Vec<RuntimeRestoreWindowRecord> {
        self.state
            .lock()
            .map(|state| state.dormant_windows.clone())
            .unwrap_or_default()
    }

    pub(crate) fn retire_dormant_window(&self, window_id: &str) -> bool {
        let retired = if let Ok(mut state) = self.state.lock() {
            let previous_len = state.dormant_windows.len();
            state.dormant_windows.retain(|window| window.id != window_id);
            state.dormant_window_states.remove(window_id);
            state.recovery_required = state.recovery_required && !state.dormant_windows.is_empty();
            if !state.recovery_required {
                state.recovery_interrupted_window_ids.clear();
            }
            state.dormant_windows.len() != previous_len
        } else {
            false
        };
        if retired {
            self.publish_projection();
        }
        retired
    }

    pub fn publish_projection(&self) {
        let Ok(snapshot) = self.core.runtime_kernel().snapshot() else {
            return;
        };
        let Some(snapshot) = self.compose_live_runtime_snapshot(snapshot.browser_runtime.roles)
        else {
            return;
        };
        // Renderer projection and native tab metadata may lag presentation, but neither path
        // owns topology or selection. Insert/replace/remove/select are committed directly by
        // LiveWindowRecord and therefore never wait for Core or a game page.
        #[cfg(target_os = "macos")]
        self.sync_native_tab_metadata(&snapshot);
        #[cfg(windows)]
        self.sync_windows_tab_metadata(&snapshot);
        #[cfg(windows)]
        self.sync_windows_tab_failure_status_surfaces();
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
        let resolved_tab_id = tab_id.to_owned();
        if let Some((window_id, operation_id)) = self
            .request_provisional_tab_presentation(
                &resolved_tab_id,
                NativePresentationFocus::WindowAndContent,
                "launcher-external",
                Some(true),
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

    fn request_provisional_tab_presentation(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
        window_visibility: Option<bool>,
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
                .native_resources.display_hosts
                .get(&window_id)
                .ok_or_else(|| "Runtime display host was not found.".to_owned())?
                .window
                .clone();
            (window_id, window)
        };
        let (previous_tab_id, previous_surfaces, revision) = {
            if !self.presentation.window_contains_tab(&window_id, tab_id) {
                return Ok(None);
            }
            let (before, _after, revision) = self.presentation.commit_live_selection(
                "command",
                &window_id,
                Some(tab_id),
            )?;
            let previous_tab_id = before.selected_tab_id;
            let previous_surfaces = self
                .presentation
                .surfaces(&window_id, previous_tab_id.as_deref());
            (previous_tab_id, previous_surfaces, revision)
        };
        if trigger == "native-pointer" {
            self.remember_native_active_style(&window_id, Some(tab_id));
        } else if trigger != "surface-attached" {
            self.schedule_native_active_style(
                window_id.clone(),
                Some(tab_id.to_owned()),
                revision,
                trigger,
            );
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
            None,
        );
        Ok(Some((window_id, presentation_operation_id)))
    }

    fn request_tab_presentation(
        &self,
        tab_id: &str,
        focus: NativePresentationFocus,
        trigger: &'static str,
    ) -> Result<(String, u64, String), String> {
        self.request_tab_presentation_with_window_visibility(tab_id, focus, trigger, None)
    }

    fn reconcile_window_presentation(
        &self,
        window_id: &str,
        trigger: &'static str,
    ) -> Result<(u64, String), String> {
        self.reconcile_window_presentation_with_visibility(window_id, trigger, None)
    }

    fn reconcile_window_presentation_with_visibility(
        &self,
        window_id: &str,
        trigger: &'static str,
        window_visibility: Option<bool>,
    ) -> Result<(u64, String), String> {
        let requested_at = Instant::now();
        let window = self
            .window_for_id(window_id)
            .ok_or_else(|| "Runtime display host was not found.".to_owned())?;
        let live = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "The live runtime window is no longer available.".to_owned())?;
        let (tab_id, revision) = (live.selected_tab_id.clone(), live.revision);
        let next_surfaces = self
            .presentation
            .surfaces(window_id, tab_id.as_deref());
        let active_webview = next_surfaces.first().cloned();
        let operation_id = self.dispatch_native_presentation(
            window_id.to_owned(),
            tab_id,
            revision,
            trigger,
            requested_at,
            window,
            None,
            Vec::new(),
            next_surfaces,
            active_webview,
            window_visibility,
            NativePresentationFocus::None,
            None,
            None,
        );
        Ok((revision, operation_id))
    }

    fn reconcile_surface_membership(&self, window_id: &str, trigger: &'static str) {
        let _ = self.reconcile_window_presentation(window_id, trigger);
    }

    fn unbind_surface_and_reconcile(
        &self,
        instance_id: &str,
        surface_label: &str,
        trigger: &'static str,
    ) {
        if let Some(window_id) = self
            .presentation
            .unbind_surface(instance_id, surface_label)
        {
            self.reconcile_surface_membership(&window_id, trigger);
        }
    }

    fn request_window_contract_presentation(
        &self,
        window_id: &str,
        window_visibility: Option<bool>,
        focus: NativePresentationFocus,
        window_mode: Option<NativeWindowMode>,
        trigger: &'static str,
    ) -> RuntimeResult<(u64, String)> {
        self.request_window_contract_presentation_with_launch_trace(
            window_id,
            window_visibility,
            focus,
            window_mode,
            trigger,
            None,
        )
    }

    fn request_window_contract_presentation_with_launch_trace(
        &self,
        window_id: &str,
        window_visibility: Option<bool>,
        focus: NativePresentationFocus,
        window_mode: Option<NativeWindowMode>,
        trigger: &'static str,
        launch_latency_trace: Option<RuntimeLaunchLatencyTrace>,
    ) -> RuntimeResult<(u64, String)> {
        self.mark_critical_activity();
        let window = {
            let state = self.state()?;
            state
                .native_resources.display_hosts
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
        let (active_tab_id, active_surfaces, active_webview, revision) = {
            let live = self.presentation.existing(window_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The native window no longer belongs to live topology.",
                )
            })?;
            let active_tab_id = live.selected_tab_id.clone();
            let revision = live.revision;
            let active_surfaces = self
                .presentation
                .surfaces(window_id, active_tab_id.as_deref());
            let active_webview = active_surfaces.first().cloned();
            (active_tab_id, active_surfaces, active_webview, revision)
        };
        self.apply_native_active_style(window_id, active_tab_id.as_deref(), revision, trigger);
        let operation_id = self.dispatch_native_presentation(
            window_id.to_owned(),
            active_tab_id.clone(),
            revision,
            trigger,
            Instant::now(),
            window,
            active_tab_id,
            active_surfaces.clone(),
            active_surfaces,
            active_webview,
            window_visibility,
            focus,
            window_mode,
            launch_latency_trace,
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
        self.mark_critical_activity();
        let requested_at = Instant::now();
        let window_id = self.resolve_live_presentation_tab_owner(tab_id)?;
        let window = self
            .window_for_id(&window_id)
            .ok_or_else(|| "Runtime display host was not found.".to_owned())?;
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
            let (before, after, revision) = self.presentation.commit_live_selection(
                if matches!(trigger, "native-pointer" | "shortcut") {
                    if cfg!(target_os = "macos") {
                        "appKit"
                    } else {
                        "html"
                    }
                } else {
                    "command"
                },
                &window_id,
                Some(tab_id),
            )?;
            let previous_tab_id = before.selected_tab_id.clone();
            let previous_surfaces = self
                .presentation
                .surfaces(&window_id, previous_tab_id.as_deref());
            let next_surfaces = self.presentation.surfaces(&window_id, Some(tab_id));
            let active_webview = next_surfaces.first().cloned();
            let was_hidden = before.tab_is_hidden(tab_id);
            let tab_presentation = before
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .cloned()
                .ok_or_else(|| "Runtime tab presentation metadata was not found.".to_owned())?;
            (
                previous_tab_id,
                previous_surfaces,
                next_surfaces,
                active_webview,
                after.tab_ids(),
                revision,
                was_hidden,
                tab_presentation,
            )
        };
        if was_hidden {
            self.schedule_native_tab_unhide_projection(
                window_id.clone(),
                tab_presentation,
                ordered_tab_ids.clone(),
                revision,
            );
            self.schedule_live_window_state_persistence(&window_id);
        }
        if trigger == "native-pointer" {
            self.remember_native_active_style(&window_id, Some(tab_id));
        } else if trigger != "surface-attached" && !was_hidden {
            self.schedule_native_active_style(
                window_id.clone(),
                Some(tab_id.to_owned()),
                revision,
                trigger,
            );
        }
        #[cfg(windows)]
        self.layout_runtime_tab(tab_id)
            .map_err(|error| error.message)?;
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
            None,
        );
        Ok((window_id, revision, presentation_operation_id))
    }

}
