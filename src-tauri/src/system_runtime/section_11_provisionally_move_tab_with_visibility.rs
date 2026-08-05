impl SystemRuntimeExecutor {
    fn provisionally_move_tab_with_visibility_inner(
        &self,
        tab_id: &str,
        target_window_id: &str,
        reveal_hidden_target: bool,
        live_drag: bool,
    ) -> Result<(), String> {
        let (source_window_id, source_window, target_window, surfaces) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "The System WebView runtime state lock was poisoned.".to_owned())?;
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
            let source_window_id = tab.window_id.clone();
            let source_window = state
                .display_hosts
                .get(&source_window_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| "Source Game Window was not found.".to_owned())?;
            let target_window = state
                .display_hosts
                .get(target_window_id)
                .map(|host| host.window.clone())
                .ok_or_else(|| "Provisional Game Window was not found.".to_owned())?;
            let mut surfaces = tab
                .roles
                .values()
                .map(|role| role.webview.clone())
                .collect::<Vec<_>>();
            surfaces.extend(
                tab.slots
                    .values()
                    .filter_map(|slot| slot.placeholder.as_ref())
                    .map(|placeholder| placeholder.webview.clone()),
            );
            surfaces.extend(tab.dividers.iter().map(|divider| divider.webview.clone()));
            (source_window_id, source_window, target_window, surfaces)
        };
        if source_window_id == target_window_id {
            return Ok(());
        }
        let presentation_precommitted = self
            .presentation
            .window_contains_tab(target_window_id, tab_id)
            && !self
                .presentation
                .window_contains_tab(&source_window_id, tab_id);
        let presentation_window_id = if presentation_precommitted {
            target_window_id
        } else {
            source_window_id.as_str()
        };
        let tab_presentation = self
            .presentation
            .tab(presentation_window_id, tab_id)
            .ok_or_else(|| "Runtime tab presentation was not found.".to_owned())?;
        let selected_tabs_before_move = self.presentation.selected_tabs();
        let mut native_move = ProvisionalNativeTabMove {
            relocated: false,
            source_active_after_move: None,
            source_active_before_move: selected_tabs_before_move.get(&source_window_id).cloned(),
            tab: tab_presentation,
            target_active_after_move: None,
            target_active_before_move: selected_tabs_before_move.get(target_window_id).cloned(),
        };
        let tab_was_visible = if presentation_precommitted {
            native_move.target_active_before_move.as_deref() == Some(tab_id)
        } else {
            native_move.source_active_before_move.as_deref() == Some(tab_id)
        };
        let source_window_was_visible = source_window
            .is_visible()
            .map_err(|error| error.to_string())?;
        let target_window_was_visible = target_window
            .is_visible()
            .map_err(|error| error.to_string())?;

        let hide_surfaces_before_reparent = !(cfg!(target_os = "macos") && live_drag);
        if hide_surfaces_before_reparent {
            for surface in &surfaces {
                if let Err(error) = surface.hide() {
                    let rollback_errors = self.rollback_provisional_tab_move(
                        tab_id,
                        &source_window_id,
                        target_window_id,
                        &source_window,
                        &target_window,
                        &surfaces,
                        0,
                        false,
                        &native_move,
                        tab_was_visible,
                        source_window_was_visible,
                        target_window_was_visible,
                    );
                    return Err(self.provisional_move_error(error.to_string(), rollback_errors));
                }
            }
        }
        for (index, surface) in surfaces.iter().enumerate() {
            if let Err(error) = surface.reparent(&target_window) {
                let rollback_errors = self.rollback_provisional_tab_move(
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    &source_window,
                    &target_window,
                    &surfaces,
                    index + 1,
                    false,
                    &native_move,
                    tab_was_visible,
                    source_window_was_visible,
                    target_window_was_visible,
                );
                return Err(self.provisional_move_error(error.to_string(), rollback_errors));
            }
        }
        #[cfg(windows)]
        match synchronize_windows_reparented_surfaces(&surfaces, &target_window) {
            Ok(outcome) => self.record_windows_reparent_sync_event(
                "tab.reparent-synchronized",
                "WebView2 surfaces synchronized with the target Game Window after reparenting.",
                tab_id,
                &source_window_id,
                target_window_id,
                "provisional-move",
                Ok(&outcome),
                None,
            ),
            Err(failure) => {
                self.record_windows_reparent_sync_event(
                    "tab.reparent-sync-failed",
                    "WebView2 surfaces could not synchronize with the target Game Window.",
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    "provisional-move",
                    Err(&failure),
                    None,
                );
                let rollback_errors = self.rollback_provisional_tab_move(
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    &source_window,
                    &target_window,
                    &surfaces,
                    surfaces.len(),
                    false,
                    &native_move,
                    tab_was_visible,
                    source_window_was_visible,
                    target_window_was_visible,
                );
                return Err(self.provisional_move_error(failure.message, rollback_errors));
            }
        }
        let (source_is_empty, moved_surfaces) = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => {
                    let rollback_errors = self.rollback_provisional_tab_move(
                        tab_id,
                        &source_window_id,
                        target_window_id,
                        &source_window,
                        &target_window,
                        &surfaces,
                        surfaces.len(),
                        false,
                        &native_move,
                        tab_was_visible,
                        source_window_was_visible,
                        target_window_was_visible,
                    );
                    return Err(self.provisional_move_error(
                        "The System WebView runtime state lock was poisoned.".to_owned(),
                        rollback_errors,
                    ));
                }
            };
            let Some(tab) = state.tabs.get_mut(tab_id) else {
                drop(state);
                let rollback_errors = self.rollback_provisional_tab_move(
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    &source_window,
                    &target_window,
                    &surfaces,
                    surfaces.len(),
                    false,
                    &native_move,
                    tab_was_visible,
                    source_window_was_visible,
                    target_window_was_visible,
                );
                return Err(self.provisional_move_error(
                    "Runtime tab was not found.".to_owned(),
                    rollback_errors,
                ));
            };
            if tab.window_id != source_window_id {
                drop(state);
                let rollback_errors = self.rollback_provisional_tab_move(
                    tab_id,
                    &source_window_id,
                    target_window_id,
                    &source_window,
                    &target_window,
                    &surfaces,
                    surfaces.len(),
                    false,
                    &native_move,
                    tab_was_visible,
                    source_window_was_visible,
                    target_window_was_visible,
                );
                return Err(self.provisional_move_error(
                    "Runtime tab moved before the provisional transaction committed.".to_owned(),
                    rollback_errors,
                ));
            }
            tab.window_id = target_window_id.to_owned();
            for surface in state.surface_registry.values_mut() {
                if surface.tab_id.as_deref() == Some(tab_id) {
                    surface.window_id = target_window_id.to_owned();
                }
            }
            let moved_surfaces = state
                .surface_registry
                .values()
                .filter(|surface| surface.tab_id.as_deref() == Some(tab_id))
                .cloned()
                .collect::<Vec<_>>();
            let source_is_empty = !state
                .tabs
                .values()
                .any(|tab| tab.window_id == source_window_id);
            (source_is_empty, moved_surfaces)
        };
        for surface in &moved_surfaces {
            self.record_surface_event(
                LogLevel::Debug,
                "surface.moved",
                "Native surface ownership moved to another window.",
                surface,
            );
        }
        let move_revision = self.presentation.next_revision();
        if !presentation_precommitted
            && let Err(message) = self.presentation.move_tab(
                tab_id,
                &source_window_id,
                target_window_id,
                move_revision,
            )
        {
            let rollback_errors = self.rollback_provisional_tab_move(
                tab_id,
                &source_window_id,
                target_window_id,
                &source_window,
                &target_window,
                &surfaces,
                surfaces.len(),
                true,
                &native_move,
                tab_was_visible,
                source_window_was_visible,
                target_window_was_visible,
            );
            return Err(self.provisional_move_error(message, rollback_errors));
        }
        let selected_tabs_after_move = self.presentation.selected_tabs();
        native_move.source_active_after_move =
            selected_tabs_after_move.get(&source_window_id).cloned();
        native_move.target_active_after_move =
            selected_tabs_after_move.get(target_window_id).cloned();
        #[cfg(any(windows, target_os = "macos"))]
        let workspace_template = native_move.tab.workspace_template.as_deref();
        #[cfg(not(any(windows, target_os = "macos")))]
        let workspace_template: Option<&str> = None;
        if !presentation_precommitted && let Err(error) = self.relocate_native_tab_reservation(
            &source_window_id,
            target_window_id,
            tab_id,
            &native_move.tab.title,
            &native_move.tab.tab_type,
            workspace_template,
            native_move.source_active_after_move.as_deref(),
            native_move.target_active_before_move.as_deref(),
            move_revision,
        ) {
            if error.code == "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED" {
                self.health.mark_unhealthy();
            }
            let rollback_errors = self.rollback_provisional_tab_move(
                tab_id,
                &source_window_id,
                target_window_id,
                &source_window,
                &target_window,
                &surfaces,
                surfaces.len(),
                true,
                &native_move,
                tab_was_visible,
                source_window_was_visible,
                target_window_was_visible,
            );
            return Err(self.provisional_move_error(error.message, rollback_errors));
        }
        native_move.relocated = !presentation_precommitted;
        let source_presentation_result = if let Some(source_active_tab_id) =
            native_move.source_active_after_move.as_deref()
        {
            self.request_tab_presentation(
                source_active_tab_id,
                NativePresentationFocus::None,
                "provisional-move-source",
            )
                .map(|_| ())
        } else {
            self.apply_native_active_style(
                &source_window_id,
                None,
                move_revision,
                "provisional-move-source",
            );
            Ok(())
        };
        if let Err(message) = source_presentation_result {
            if presentation_precommitted {
                return Err(message);
            }
            let rollback_errors = self.rollback_provisional_tab_move(
                tab_id,
                &source_window_id,
                target_window_id,
                &source_window,
                &target_window,
                &surfaces,
                surfaces.len(),
                true,
                &native_move,
                tab_was_visible,
                source_window_was_visible,
                target_window_was_visible,
            );
            return Err(self.provisional_move_error(message, rollback_errors));
        }
        self.apply_native_active_style(
            target_window_id,
            native_move.target_active_after_move.as_deref(),
            move_revision,
            "provisional-move",
        );
        let reveal_result = (|| {
            if !(cfg!(target_os = "macos") && live_drag) {
                self.layout_runtime_tab(tab_id)
                    .map_err(|error| error.message)?;
            }
            if tab_was_visible {
                for surface in &surfaces {
                    if hide_surfaces_before_reparent {
                        surface.show().map_err(|error| error.to_string())?;
                    }
                }
                if reveal_hidden_target || target_window_was_visible {
                    target_window.show().map_err(|error| error.to_string())?;
                }
            }
            if source_is_empty {
                source_window.hide().map_err(|error| error.to_string())?;
            }
            Ok::<(), String>(())
        })();
        if let Err(message) = reveal_result {
            if presentation_precommitted {
                return Err(message);
            }
            let rollback_errors = self.rollback_provisional_tab_move(
                tab_id,
                &source_window_id,
                target_window_id,
                &source_window,
                &target_window,
                &surfaces,
                surfaces.len(),
                true,
                &native_move,
                tab_was_visible,
                source_window_was_visible,
                target_window_was_visible,
            );
            return Err(self.provisional_move_error(message, rollback_errors));
        }
        if cfg!(target_os = "macos") && live_drag {
            self.schedule_live_tab_drag_layout(tab_id.to_owned());
        }
        if !presentation_precommitted && !live_drag {
            self.publish_projection();
        }
        Ok(())
    }

    fn schedule_live_tab_drag_layout(&self, tab_id: String) {
        let Some(runtime) = self.self_weak.get().cloned() else {
            return;
        };
        let _ = thread::Builder::new()
            .name(format!("rion-tab-drag-layout-{tab_id}"))
            .spawn(move || {
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                if let Err(error) = runtime.layout_runtime_tab(&tab_id) {
                    eprintln!("Live tab drag layout remains pending: tab={tab_id} error={}", error.message);
                }
            });
    }

    pub(crate) fn show_tab_drag_window(&self, window_id: &str) -> Result<(), String> {
        self.window_for_id(window_id)
            .ok_or_else(|| "Tab drag window was not found.".to_owned())?
            .show()
            .map_err(|error| error.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    fn rollback_provisional_tab_move(
        &self,
        tab_id: &str,
        source_window_id: &str,
        target_window_id: &str,
        source_window: &Window,
        target_window: &Window,
        surfaces: &[Webview],
        reparent_attempted: usize,
        state_committed: bool,
        native_move: &ProvisionalNativeTabMove,
        tab_was_visible: bool,
        source_window_was_visible: bool,
        target_window_was_visible: bool,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        let mut rolled_back_surfaces = Vec::new();
        if reparent_attempted > 0 {
            for surface in surfaces {
                if let Err(error) = surface.hide() {
                    errors.push(format!("hide {}: {error}", surface.label()));
                }
            }
            for surface in surfaces.iter().take(reparent_attempted).rev() {
                if let Err(error) = surface.reparent(source_window) {
                    errors.push(format!("reparent {}: {error}", surface.label()));
                }
            }
            #[cfg(windows)]
            {
                let rollback_surfaces = &surfaces[..reparent_attempted.min(surfaces.len())];
                match synchronize_windows_reparented_surfaces(rollback_surfaces, source_window) {
                    Ok(outcome) => self.record_windows_reparent_sync_event(
                        "tab.reparent-sync-rolled-back",
                        "WebView2 surfaces synchronized with their source Game Window during rollback.",
                        tab_id,
                        target_window_id,
                        source_window_id,
                        "provisional-rollback",
                        Ok(&outcome),
                        Some(errors.len()),
                    ),
                    Err(failure) => {
                        errors.push(format!("reparent sync: {}", failure.message));
                        self.record_windows_reparent_sync_event(
                            "tab.reparent-sync-rolled-back",
                            "WebView2 surfaces did not fully synchronize with their source Game Window during rollback.",
                            tab_id,
                            target_window_id,
                            source_window_id,
                            "provisional-rollback",
                            Err(&failure),
                            Some(errors.len()),
                        );
                    }
                }
            }
        }
        if state_committed {
            let rollback_revision = self.presentation.next_revision();
            if self
                .presentation
                .window_contains_tab(target_window_id, tab_id)
            {
                if let Err(error) = self.presentation.move_tab(
                    tab_id,
                    target_window_id,
                    source_window_id,
                    rollback_revision,
                ) {
                    errors.push(format!("presentation rollback: {error}"));
                }
            } else if !self
                .presentation
                .window_contains_tab(source_window_id, tab_id)
            {
                errors.push("presentation tab disappeared during rollback".to_owned());
            }
            match self.state.lock() {
                Ok(mut state) => match state.tabs.get_mut(tab_id) {
                    Some(tab) if tab.window_id == target_window_id => {
                        tab.window_id = source_window_id.to_owned();
                        for surface in state.surface_registry.values_mut() {
                            if surface.tab_id.as_deref() == Some(tab_id) {
                                surface.window_id = source_window_id.to_owned();
                                rolled_back_surfaces.push(surface.clone());
                            }
                        }
                    }
                    Some(_) => errors.push("runtime tab host changed during rollback".to_owned()),
                    None => errors.push("runtime tab disappeared during rollback".to_owned()),
                },
                Err(_) => errors.push("runtime state lock was poisoned during rollback".to_owned()),
            }
            for surface in &rolled_back_surfaces {
                self.record_surface_event(
                    LogLevel::Warn,
                    "surface.move-rolled-back",
                    "Native surface ownership move was rolled back.",
                    surface,
                );
            }
            if native_move.relocated {
                #[cfg(any(windows, target_os = "macos"))]
                let workspace_template = native_move.tab.workspace_template.as_deref();
                #[cfg(not(any(windows, target_os = "macos")))]
                let workspace_template: Option<&str> = None;
                match self.relocate_native_tab_reservation(
                    target_window_id,
                    source_window_id,
                    tab_id,
                    &native_move.tab.title,
                    &native_move.tab.tab_type,
                    workspace_template,
                    native_move.target_active_before_move.as_deref(),
                    native_move.source_active_after_move.as_deref(),
                    rollback_revision,
                ) {
                    Ok(()) => self.apply_native_active_style(
                        source_window_id,
                        native_move.source_active_before_move.as_deref(),
                        rollback_revision,
                        "provisional-rollback",
                    ),
                    Err(error) => errors.push(format!("native tab rollback: {}", error.message)),
                }
            }
            if let Err(error) = self.layout_runtime_tab(tab_id) {
                errors.push(format!("layout: {}", error.message));
            }
        }
        if tab_was_visible {
            for surface in surfaces {
                if let Err(error) = surface.show() {
                    errors.push(format!("show {}: {error}", surface.label()));
                }
            }
        }
        let source_visibility = if source_window_was_visible {
            source_window.show()
        } else {
            source_window.hide()
        };
        if let Err(error) = source_visibility {
            errors.push(format!("source window visibility: {error}"));
        }
        let target_visibility = if target_window_was_visible {
            target_window.show()
        } else {
            target_window.hide()
        };
        if let Err(error) = target_visibility {
            errors.push(format!("target window visibility: {error}"));
        }
        self.publish_projection();
        errors
    }

    fn provisional_move_error(&self, original: String, rollback_errors: Vec<String>) -> String {
        if rollback_errors.is_empty() {
            return original;
        }
        self.health.mark_unhealthy();
        provisional_move_failure_message(original, &rollback_errors)
    }

    pub fn cancel_provisional_tab_move(
        &self,
        tab_id: &str,
        source_window_id: &str,
        provisional_window_id: &str,
    ) -> Result<(), String> {
        let current_window_id = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.tabs.get(tab_id).map(|tab| tab.window_id.clone()));
        let rollback = if current_window_id
            .as_deref()
            .is_some_and(|window_id| window_id != source_window_id)
        {
            self.provisionally_move_tab(tab_id, source_window_id)
        } else {
            Ok(())
        };
        if let Some(source) = self.window_for_id(source_window_id) {
            let _ = source.show();
            let _ = self.focus_runtime_window_direct(
                source_window_id,
                &source,
                "cancelProvisionalTabMove",
            );
        }
        self.discard_provisional_game_window(provisional_window_id);
        self.publish_projection();
        rollback
    }

    pub fn discard_provisional_game_window(&self, window_id: &str) {
        let Some((host, can_discard)) = self.state.lock().ok().map(|mut state| {
            if state.tabs.values().any(|tab| tab.window_id == window_id) {
                return (None, false);
            }
            let host = state.display_hosts.remove(window_id);
            if let Some(host) = host.as_ref() {
                state
                    .allow_window_close_labels
                    .insert(host.window.label().to_owned());
            }
            (host, true)
        }) else {
            return;
        };
        if !can_discard {
            return;
        }
        self.presentation.remove(window_id);
        self.publish_launcher_presence();
        if let Some(host) = host {
            self.focus_broker
                .revoke_window(window_id, host.generation);
            self.unregister_runtime_launcher_window(window_id);
            let _ = host.window.close();
        }
    }

    pub fn window_id_for_label(&self, label: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label).then(|| window_id.clone())
            })
        })
    }

    #[cfg(windows)]
    pub fn tab_strip_window_for_webview(&self, webview_label: &str) -> Option<String> {
        self.state.lock().ok().and_then(|state| {
            state.display_hosts.values().find_map(|host| {
                (host.tab_strip.label() == webview_label).then(|| host.target.window_id.clone())
            })
        })
    }

    #[cfg(not(windows))]
    pub fn tab_strip_window_for_webview(&self, _webview_label: &str) -> Option<String> {
        None
    }

    pub fn reload_tab(
        self: &Arc<Self>,
        tab_id: &str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        let operation_id = self
            .reload_tab_contract(tab_id)
            .map_err(|error| error.message)?;
        self.wait_native_operation_summary(&operation_id)
    }

    pub fn set_tab_audio_muted(
        &self,
        tab_id: &str,
        muted: bool,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.require_runtime_accepting()
            .map_err(|error| error.message)?;
        let (role_id, window_id, surface_generation) = {
            let state = self.state().map_err(|error| error.message)?;
            let tab = state
                .tabs
                .get(tab_id)
                .ok_or_else(|| "runtime tab was not found".to_owned())?;
            let role_id = tab
                .roles
                .keys()
                .next()
                .cloned()
                .ok_or_else(|| "runtime tab has no owned role surface".to_owned())?;
            let surface_generation = tab.roles.get(&role_id).map(|role| role.generation);
            (role_id, tab.window_id.clone(), surface_generation)
        };
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Audio,
            "setGameWindowTabMuted",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement)
        .with_role(&role_id)
        .with_tab(tab_id)
        .with_window(window_id.clone());
        operation.surface_generation = surface_generation;
        self.operations
            .register(operation.clone())
            .map_err(str::to_owned)?;
        if !self.operations.mark_in_flight(&operation.operation_id) {
            return self.wait_native_operation_summary(&operation.operation_id);
        }
        if let Err(error) = self.apply_role_audio_muted(&role_id, muted) {
            let status = if error.code == "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED" {
                NativeOperationStatus::Indeterminate
            } else {
                NativeOperationStatus::Failed
            };
            let mut receipt = NativeOperationReceipt::with_status(
                operation,
                "audioMuteFailed",
                status,
                Some(error.code),
            );
            if let Some(count) = error.rollback_error_count {
                receipt = receipt.with_rollback_error_count(count as usize);
            }
            return Ok(self.operations.complete(receipt).summary());
        }
        self.publish_projection();
        if let Err(error) = self.touch_live_window_state(&window_id) {
            eprintln!("Live tab audio revision could not advance: window={window_id} error={error}");
        }
        self.schedule_live_window_state_persistence(&window_id);
        Ok(self
            .operations
            .complete(NativeOperationReceipt::applied(
                operation,
                "audioMuteApplied",
            ))
            .summary())
    }

    #[cfg(windows)]
    pub fn set_windows_toolbar_revealed(
        &self,
        window_id: &str,
        revealed: bool,
    ) -> Result<(), String> {
        let tab_ids = {
            let mut state = self.state().map_err(|error| error.message)?;
            let host = state
                .display_hosts
                .get_mut(window_id)
                .ok_or_else(|| "Runtime display host was not found".to_owned())?;
            host.toolbar_revealed = revealed;
            state
                .tabs
                .iter()
                .filter_map(|(tab_id, tab)| (tab.window_id == window_id).then_some(tab_id.clone()))
                .collect::<Vec<_>>()
        };
        for tab_id in tab_ids {
            self.layout_runtime_tab(&tab_id)
                .map_err(|error| error.message)?;
        }
        self.publish_projection();
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn set_windows_toolbar_revealed(
        &self,
        _window_id: &str,
        _revealed: bool,
    ) -> Result<(), String> {
        Err("Windows runtime tab strip is unavailable on this platform".to_owned())
    }
}
