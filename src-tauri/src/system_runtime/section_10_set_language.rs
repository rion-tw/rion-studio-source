impl SystemRuntimeExecutor {
    pub fn set_language(&self, language: &str) {
        if matches!(language, "en" | "zh-TW" | "zh-CN" | "ja") {
            if let Ok(mut current) = self.language.lock() {
                *current = language.to_owned();
            }
            self.publish_projection();
        }
    }

    pub fn set_theme(&self, theme: &str) {
        if matches!(theme, "light" | "dark") {
            if let Ok(mut current) = self.resolved_theme.lock() {
                *current = theme.to_owned();
            }
            #[cfg(windows)]
            self.publish_projection();
        }
    }

    pub(crate) fn native_menu_context_for_tab(
        &self,
        tab_id: &str,
    ) -> Result<(Window, bool), String> {
        let window_id = self
            .presentation
            .tab_window(tab_id)?
            .ok_or_else(|| "Runtime tab is no longer in live topology.".to_owned())?;
        let state = self
            .state
            .lock()
            .map_err(|_| "The runtime tab menu context is unavailable.".to_owned())?;
        let audio_muted = self
            .presentation
            .tab(&window_id, tab_id)
            .map(|tab| tab.audio_muted)
            .unwrap_or(false);
        let window = state
            .native_resources.display_hosts
            .get(&window_id)
            .map(|host| host.window.clone())
            .ok_or_else(|| "Runtime tab window was not found.".to_owned())?;
        Ok((window, audio_muted))
    }

    pub(crate) fn tab_audio_muted(&self, tab_id: &str) -> Result<bool, String> {
        Ok(self
            .presentation
            .tab_window(tab_id)?
            .and_then(|window_id| self.presentation.tab(&window_id, tab_id))
            .map(|tab| tab.audio_muted)
            .unwrap_or(false))
    }

    pub fn window_for_id(&self, window_id: &str) -> Option<Window> {
        self.state.lock().ok().and_then(|state| {
            state
                .native_resources.display_hosts
                .get(window_id)
                .map(|host| host.window.clone())
        })
    }

    pub(crate) fn presented_tab_for_launcher_source(
        &self,
        source_id: &str,
        tab_type: &str,
    ) -> Option<String> {
        if let Some(tab_id) = self.presented_stable_tab_for_launcher_source(source_id, tab_type) {
            return Some(tab_id);
        }
        if let Ok(snapshot) = self.core.runtime_kernel().snapshot()
            && let Some(tab_id) = snapshot.windows.values().find_map(|window| {
                window.tabs.iter().find_map(|tab| {
                    (tab.source_id == source_id
                        && tab.tab_type == tab_type
                        && snapshot.tab_activations.contains_key(&tab.id))
                    .then(|| tab.id.clone())
                })
            })
        {
            return Some(tab_id);
        }
        let provisional = self.state.lock().ok().and_then(|state| {
            active_provisional_launch(&state, source_id, tab_type).cloned()
        })?;
        let presented_window_id = self
            .presentation
            .tab_window(&provisional.id)
            .ok()
            .flatten();
        if provisional_launch_has_live_presentation(
            &provisional,
            presented_window_id.as_deref(),
        ) {
            return Some(provisional.id);
        }
        self.cancel_tab_launch_preview(&provisional.launch_preview_id);
        None
    }

    pub(crate) fn presented_stable_tab_for_launcher_source(
        &self,
        source_id: &str,
        tab_type: &str,
    ) -> Option<String> {
        let live_owner = if tab_type == "role" {
            self.state.lock().ok().and_then(|state| {
                state
                    .native_tab_id_for_role_surface(source_id)
                    .filter(|tab_id| !state.tab_close_pending(tab_id))
                    .cloned()
            })
        } else {
            None
        };
        let candidates = live_owner.into_iter().chain(
            self.presentation
                .tabs_for_launcher_source(source_id, tab_type),
        );
        let state = self.state.lock().ok()?;
        candidates.into_iter().find(|tab_id| {
            state.native_resources.tabs.contains_key(tab_id) && !state.tab_close_pending(tab_id)
        })
    }

    pub(crate) fn cancel_active_launch_preview_for_source(
        &self,
        source_id: &str,
        tab_type: &str,
    ) -> bool {
        let launch_preview_id = self.state.lock().ok().and_then(|state| {
            active_provisional_launch(&state, source_id, tab_type)
                .map(|launch| launch.launch_preview_id.clone())
        });
        let Some(launch_preview_id) = launch_preview_id else {
            return false;
        };
        self.cancel_tab_launch_preview(&launch_preview_id);
        true
    }

    pub(crate) fn launcher_presence_snapshot(&self) -> Result<RuntimeLauncherPresence, String> {
        let mut presence = self.presentation.launcher_presence()?;
        let live_tab_ids = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            state
                .native_resources.tabs
                .keys()
                .filter(|tab_id| !state.tab_close_pending(tab_id))
                .cloned()
                .chain(
                    state
                        .provisional_launches
                        .values()
                        .filter(|launch| !launch.cancelled)
                        .map(|launch| launch.id.clone()),
                )
                .collect::<HashSet<_>>()
        };
        retain_live_runtime_launcher_tabs(&mut presence, &live_tab_ids);
        Ok(presence)
    }

    fn publish_launcher_presence(&self) {
        let Ok(presence) = self.launcher_presence_snapshot() else {
            return;
        };
        let Some(state) = self.app.try_state::<crate::CoreState>() else {
            return;
        };
        if let Err(error) = state
            .runtime_launcher_refresh
            .update_presence(&self.app, presence)
        {
            eprintln!("Runtime launcher presence refresh failed: {error}");
        }
        let language = state
            .menu_language
            .lock()
            .map(|language| language.clone())
            .unwrap_or_else(|_| "en".to_owned());
        if let Some(runtime) = self.self_weak.get().and_then(|runtime| runtime.upgrade())
            && let Err(error) = state.quick_menu_refresh.request(
                self.app.clone(),
                Arc::clone(&state.core),
                runtime,
                language,
            )
        {
            eprintln!("Quick Menu live topology refresh failed: {error}");
        }
    }

    pub fn window_id_for_webview(&self, webview_label: &str) -> Option<String> {
        let tab_id = self.state.lock().ok().and_then(|state| {
            let popup_role_id = state.popup_roles.get(webview_label);
            state.native_resources.tabs.iter().find_map(|(tab_id, tab)| {
                let owns_webview = popup_role_id
                    .is_some_and(|role_id| tab.roles.contains_key(role_id))
                    || tab
                        .roles
                        .values()
                        .any(|surface| surface.webview.label() == webview_label);
                owns_webview.then(|| tab_id.clone())
            })
        })?;
        self.presentation.tab_window(&tab_id).ok().flatten()
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn begin_macos_shortcut_modifier_handoff(&self, window_id: &str, tab_id: &str) {
        self.begin_shortcut_modifier_handoff(RuntimeShortcutModifierHandoff {
            modifier_codes: Vec::new(),
            source_tab_id: tab_id.to_owned(),
            started_at: Instant::now(),
            window_id: window_id.to_owned(),
        });
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn finish_macos_shortcut_modifier_handoff(
        &self,
        window_id: &str,
        fallback_tab_id: Option<&str>,
        abandoned: bool,
    ) {
        let handoff = self.take_shortcut_modifier_handoff(window_id, fallback_tab_id);
        let reassertion = self.reassert_shortcut_handoff_keys(&handoff);
        let (phase, level, error) = match reassertion {
            Ok(()) if abandoned => ("abandoned", LogLevel::Debug, None),
            Ok(()) => ("completed", LogLevel::Debug, None),
            Err(error) => (
                "failed",
                LogLevel::Warn,
                Some(log_error_details(error.code, &error.message)),
            ),
        };
        self.record_shortcut_modifier_handoff(&handoff, phase, level, error);
    }

    #[cfg(windows)]
    fn begin_windows_shortcut_modifier_handoff(
        &self,
        webview_label: &str,
        modifier_codes: Vec<String>,
        target_tab_id: &str,
    ) -> Result<Option<String>, String> {
        let (tab_id, role_id) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            state
                .native_resources.tabs
                .iter()
                .find_map(|(tab_id, tab)| {
                    tab.roles.iter().find_map(|(role_id, surface)| {
                        (surface.webview.label() == webview_label)
                            .then(|| (tab_id.clone(), role_id.clone()))
                    })
                })
                .ok_or_else(|| "The shortcut source WebView was not found.".to_owned())?
        };
        if tab_id == target_tab_id {
            return Ok(None);
        }
        let window_id = self
            .presentation
            .tab_window(&tab_id)?
            .ok_or_else(|| "The shortcut source tab is no longer live.".to_owned())?;
        self.begin_shortcut_modifier_handoff(RuntimeShortcutModifierHandoff {
            modifier_codes,
            source_role_id: Some(role_id),
            source_tab_id: tab_id,
            source_webview_label: Some(webview_label.to_owned()),
            started_at: Instant::now(),
            window_id: window_id.clone(),
        });
        Ok(Some(window_id))
    }

    #[cfg(windows)]
    fn finish_windows_shortcut_modifier_handoff(&self, window_id: &str) {
        let handoff = self.take_shortcut_modifier_handoff(window_id, None);
        let release = self.release_windows_shortcut_modifiers(&handoff);
        let reassertion = self.reassert_shortcut_handoff_keys(&handoff);
        let result = match (release, reassertion) {
            (Err(error), _) | (_, Err(error)) => Err(error),
            (Ok(released), Ok(())) => Ok(released),
        };
        let (phase, level, error) = match result {
            Ok(true) => ("completed", LogLevel::Debug, None),
            Ok(false) => ("abandoned", LogLevel::Debug, None),
            Err(error) => (
                "failed",
                LogLevel::Warn,
                Some(log_error_details(error.code, &error.message)),
            ),
        };
        self.record_shortcut_modifier_handoff(&handoff, phase, level, error);
    }

    fn begin_shortcut_modifier_handoff(&self, handoff: RuntimeShortcutModifierHandoff) {
        let inserted = self
            .shortcut_modifier_handoffs
            .lock()
            .ok()
            .and_then(|mut handoffs| {
                if handoffs.contains_key(&handoff.window_id) {
                    None
                } else {
                    handoffs.insert(handoff.window_id.clone(), handoff.clone());
                    Some(())
                }
            })
            .is_some();
        if inserted {
            self.record_shortcut_modifier_handoff(&handoff, "started", LogLevel::Debug, None);
        }
    }

    fn take_shortcut_modifier_handoff(
        &self,
        window_id: &str,
        fallback_tab_id: Option<&str>,
    ) -> RuntimeShortcutModifierHandoff {
        self.shortcut_modifier_handoffs
            .lock()
            .ok()
            .and_then(|mut handoffs| handoffs.remove(window_id))
            .unwrap_or_else(|| RuntimeShortcutModifierHandoff {
                modifier_codes: Vec::new(),
                #[cfg(windows)]
                source_role_id: None,
                source_tab_id: fallback_tab_id.unwrap_or_default().to_owned(),
                #[cfg(windows)]
                source_webview_label: None,
                started_at: Instant::now(),
                window_id: window_id.to_owned(),
            })
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn reassert_shortcut_handoff_keys(
        &self,
        handoff: &RuntimeShortcutModifierHandoff,
    ) -> RuntimeResult<()> {
        let selected_tab_id = self
            .presentation
            .existing(&handoff.window_id)
            .and_then(|presentation| presentation.selected_tab_id.clone());
        let mut tab_ids = vec![handoff.source_tab_id.as_str()];
        if let Some(selected_tab_id) = selected_tab_id.as_deref()
            && selected_tab_id != handoff.source_tab_id
        {
            tab_ids.push(selected_tab_id);
        }
        let mut roles = {
            let state = self.state()?;
            tab_ids
                .into_iter()
                .filter(|tab_id| !tab_id.is_empty())
                .filter_map(|tab_id| state.native_resources.tabs.get(tab_id))
                .flat_map(|tab| {
                    tab.roles
                        .iter()
                        .map(|(role_id, surface)| (role_id.clone(), surface.webview.clone()))
                })
                .collect::<Vec<_>>()
        };
        roles.sort_by(|left, right| left.0.cmp(&right.0));
        roles.dedup_by(|left, right| left.0 == right.0);
        roles.iter().try_for_each(|(role_id, _webview)| {
            self.with_role_input_lane(role_id, || {
                let context = self.current_input_context(role_id, "normal")?;
                self.reassert_role_keys_in_lane(role_id, &context)
            })
        })
    }

    #[cfg(windows)]
    fn release_windows_shortcut_modifiers(
        &self,
        handoff: &RuntimeShortcutModifierHandoff,
    ) -> RuntimeResult<bool> {
        let (Some(role_id), Some(webview_label)) = (
            handoff.source_role_id.as_deref(),
            handoff.source_webview_label.as_deref(),
        ) else {
            return Ok(false);
        };
        let Some(webview) = self.app.get_webview(webview_label) else {
            return Ok(false);
        };
        self.with_role_input_lane(role_id, || {
            let context = self.current_input_context(role_id, "cleanup")?;
            for effect in shortcut_modifier_release_effects(&handoff.modifier_codes) {
                dispatch_key_effect(&webview, &effect, &context)?;
            }
            Ok(true)
        })
    }

    pub(crate) fn tab_drag_window_snapshot(
        &self,
        window_id: &str,
    ) -> Result<RuntimeTabDragWindowSnapshot, String> {
        let generation = self
            .state()
            .map_err(|error| error.message)?
            .native_resources.display_hosts
            .get(window_id)
            .map(|host| host.generation)
            .ok_or_else(|| "Runtime tab drag window host was not found.".to_owned())?;
        let state = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Runtime tab presentation window was not found.".to_owned())?;
        Ok(RuntimeTabDragWindowSnapshot {
            generation,
            tab_ids: state.tab_ids(),
        })
    }

    pub(crate) fn tab_drag_window_generation_matches(
        &self,
        window_id: &str,
        generation: u64,
    ) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state
                .native_resources.display_hosts
                .get(window_id)
                .is_some_and(|host| host.generation == generation)
        })
    }

    pub(crate) fn native_tab_host_id(&self, tab_id: &str) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.native_host_for_tab_handle(tab_id))
            .or_else(|| self.presentation.tab_window(tab_id).ok().flatten())
    }

    pub(crate) fn native_tab_exists(&self, tab_id: &str) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.native_resources.tabs.contains_key(tab_id)
                && !state.tab_close_pending(tab_id)
                && !state.close_coordinator.closing_tabs.contains(tab_id)
        })
    }

    pub(crate) fn window_tab_count(&self, window_id: &str) -> usize {
        self.live_tab_ids_for_window(window_id).len()
    }

    pub(crate) fn begin_tab_drag_window_motion(&self, window_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state
                .tab_drag_placement_suppressed_windows
                .insert(window_id.to_owned());
        }
    }

    pub(crate) fn finish_tab_drag_window_motion(
        &self,
        window_id: &str,
        persist_final_placement: bool,
    ) -> Result<(), String> {
        let label = self.state.lock().ok().and_then(|mut state| {
            state
                .tab_drag_placement_suppressed_windows
                .remove(window_id);
            state
                .native_resources.display_hosts
                .get(window_id)
                .map(|host| host.window.label().to_owned())
        });
        if persist_final_placement && label.is_some() {
            let target = self.state.lock().ok().and_then(|state| {
                state
                    .native_resources.display_hosts
                    .get(window_id)
                    .map(|host| host.target.clone())
            });
            let result = target
                .ok_or_else(|| "Live Game Window drag target was retired.".to_owned())
                .and_then(|target| self.update_live_window_target(&target, true));
            if let Err(error) = result {
                eprintln!(
                    "Live Game Window drag placement snapshot could not be queued: window={window_id} error={error}"
                );
            } else {
                self.schedule_live_window_state_persistence(window_id);
            }
        }
        Ok(())
    }

    pub(crate) fn preview_tab_drag_activation(&self, tab_id: &str) -> Result<(), String> {
        self.request_tab_presentation(
            tab_id,
            NativePresentationFocus::None,
            "tab-drag-preview",
        )
            .map(|_| ())
    }

    pub(crate) fn preview_tab_drag_order(
        &self,
        window_id: &str,
        tab_id: &str,
        before_tab_id: Option<&str>,
        project_native_order: bool,
    ) -> Result<(), String> {
        let ordered = {
            let state = self
                .presentation
                .existing(window_id)
                .ok_or_else(|| "Runtime tab presentation window was not found.".to_owned())?;
            let mut ordered = state.tab_ids();
            let Some(index) = ordered.iter().position(|id| id == tab_id) else {
                return Err("Dragged tab is outside the preview window.".to_owned());
            };
            ordered.remove(index);
            let insertion = before_tab_id
                .and_then(|before| ordered.iter().position(|id| id == before))
                .unwrap_or(ordered.len());
            ordered.insert(insertion, tab_id.to_owned());
            ordered
        };
        self.preview_tab_drag_order_exact(window_id, &ordered, project_native_order)
    }

    pub(crate) fn tab_control_row_contains_screen_point(
        &self,
        window_id: &str,
        screen_x: f64,
        screen_y: f64,
    ) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.state
                .lock()
                .ok()
                .and_then(|state| {
                    state
                        .native_resources.display_hosts
                        .get(window_id)
                        .map(|host| host.tabs_controller.clone())
                })
                .is_some_and(|controller| controller.control_row_contains(screen_x, screen_y))
        }
        #[cfg(windows)]
        {
            let snapshot = self.state.lock().ok().and_then(|state| {
                let host = state.native_resources.display_hosts.get(window_id)?;
                Some((
                    host.window.clone(),
                    self.windows_tab_strip_height(&host.window, host.toolbar_revealed),
                ))
            });
            let Some((window, height)) = snapshot else {
                return false;
            };
            let Ok(position) = window.inner_position() else {
                return false;
            };
            let Ok(size) = window.inner_size() else {
                return false;
            };
            let scale = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
            let height = height * scale;
            point_in_runtime_tab_control_row(
                position.x as f64,
                position.y as f64,
                size.width as f64,
                height,
                screen_x,
                screen_y,
            )
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (window_id, screen_x, screen_y);
            false
        }
    }

    pub(crate) fn tab_drag_target_at_screen_point(
        &self,
        screen_x: f64,
        screen_y: f64,
        excluded_window_id: Option<&str>,
    ) -> Option<String> {
        let windows = self
            .state
            .lock()
            .ok()?
            .native_resources.display_hosts
            .iter()
            .filter(|(window_id, _)| excluded_window_id != Some(window_id.as_str()))
            .map(|(window_id, host)| (window_id.clone(), host.window.clone()))
            .collect::<Vec<_>>();
        windows
            .into_iter()
            .filter(|(_, window)| window.is_visible().unwrap_or(false))
            .filter(|(_, window)| {
                let Ok(position) = window.outer_position() else {
                    return false;
                };
                let Ok(size) = window.outer_size() else {
                    return false;
                };
                let window_scale = window.scale_factor().unwrap_or(1.0).max(f64::EPSILON);
                let coordinate_scale = if cfg!(windows) { 1.0 } else { window_scale };
                point_in_runtime_tab_control_row(
                    position.x as f64 / coordinate_scale,
                    position.y as f64 / coordinate_scale,
                    size.width as f64 / coordinate_scale,
                    48.0 * if cfg!(windows) { window_scale } else { 1.0 },
                    screen_x,
                    screen_y,
                )
            })
            .map(|(window_id, _)| window_id)
            .find(|window_id| {
                self.tab_control_row_contains_screen_point(window_id, screen_x, screen_y)
            })
    }

    pub(crate) fn tab_drag_window_anchor(
        &self,
        window_id: &str,
        tab_id: &str,
        grab_ratio_x: f64,
        grab_ratio_y: f64,
        _fallback_tab_width: f64,
        _fallback_tab_height: f64,
    ) -> Option<(f64, f64)> {
        #[cfg(target_os = "macos")]
        {
            let controller = self.state.lock().ok().and_then(|state| {
                state
                    .native_resources.display_hosts
                    .get(window_id)
                    .map(|host| host.tabs_controller.clone())
            })?;
            controller
                .drag_anchor(tab_id, grab_ratio_x, grab_ratio_y)
                .map(|anchor| (anchor.window_offset_x, anchor.window_offset_y))
        }
        #[cfg(windows)]
        {
            let _ = tab_id;
            let window = self.window_for_id(window_id)?;
            let outer = window.outer_position().ok()?;
            let inner = window.inner_position().ok()?;
            let scale = window.scale_factor().ok()?.max(f64::EPSILON);
            let frame_x = (inner.x - outer.x) as f64 / scale;
            let frame_y = (inner.y - outer.y) as f64 / scale;
            Some((
                frame_x + 9.0 + _fallback_tab_width.max(1.0) * grab_ratio_x.clamp(0.0, 1.0),
                frame_y
                    + (WINDOWS_TAB_STRIP_HEIGHT - _fallback_tab_height.max(1.0)) / 2.0
                    + _fallback_tab_height.max(1.0) * grab_ratio_y.clamp(0.0, 1.0),
            ))
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (
                window_id,
                tab_id,
                grab_ratio_x,
                grab_ratio_y,
                _fallback_tab_width,
                _fallback_tab_height,
            );
            None
        }
    }

    fn prepare_provisional_game_window_inner(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        title: &str,
    ) -> Result<(), String> {
        let (window, _) = self
            .ensure_display_host(target, title)
            .map_err(|error| error.message)?;
        #[cfg(not(windows))]
        set_tab_drag_window_interaction(&window, true)?;
        window.hide().map_err(|error| error.to_string())
    }

    fn make_provisional_game_window_interactive_inner(
        &self,
        window_id: &str,
    ) -> Result<(), String> {
        let (window, generation) = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .native_resources.display_hosts
                    .get(window_id)
                    .map(|host| (host.window.clone(), host.generation))
            })
            .ok_or_else(|| "Provisional Game Window was not found.".to_owned())?;
        let pointer_passthrough_leased = self.state.lock().ok().is_some_and(|state| {
            state
                .tab_drag_cursor_leases
                .get(window_id)
                .is_some_and(|lease| lease.window_generation == generation)
        });
        if pointer_passthrough_leased {
            set_tab_drag_window_interaction(&window, true)?;
            return Ok(());
        }
        set_tab_drag_window_interaction(&window, false)?;
        self.focus_runtime_window_direct(
            window_id,
            &window,
            "activateProvisionalWindow",
        )
        .map(|_| ())
        .map_err(|error| error.message)
    }

    fn position_provisional_game_window_inner(
        &self,
        target: &EmbeddedLaunchTargetRecord,
    ) -> Result<(), String> {
        match self.apply_window_geometry_target(
            target,
            GeometryMutationScope::PositionOnly,
            "positionProvisionalWindow",
        ) {
            Ok(true) => Ok(()),
            Ok(false) => Err("Provisional Game Window was not found.".to_owned()),
            Err(error) => Err(error.message),
        }
    }

    pub(crate) fn provisionally_move_tab_for_live_drag(
        &self,
        tab_id: &str,
        target_window_id: &str,
    ) -> Result<(), String> {
        self.provisionally_move_tab_with_visibility(tab_id, target_window_id, false, true)
    }

}
