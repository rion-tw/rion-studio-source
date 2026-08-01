impl SystemRuntimeExecutor {
    pub(crate) fn forget_popup(&self, window_label: &str) {
        let (role_id, released_surfaces, role_already_fenced) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let released_surfaces = state
                .surface_registry
                .values()
                .filter(|surface| {
                    surface.kind == ManagedSurfaceKind::Popup
                        && surface.webview.label() == window_label
                })
                .map(|surface| (surface.instance_id.clone(), Arc::clone(&surface.lifecycle)))
                .collect::<Vec<_>>();
            let role_id = state.popup_roles.remove(window_label);
            let role_already_fenced = role_id.as_ref().is_some_and(|role_id| {
                state.close_coordinator.closing_roles.contains(role_id)
                    || state.recovering_roles.contains(role_id)
            });
            state.audible_webviews.remove(window_label);
            state.overlay_capabilities.remove(window_label);
            state
                .close_coordinator
                .closing_webviews
                .remove(window_label);
            (role_id, released_surfaces, role_already_fenced)
        };
        let platform = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "other"
        };
        for (instance_id, lifecycle) in released_surfaces {
            lifecycle.mark_controller_released();
            #[cfg(windows)]
            lifecycle.mark_native_surface_released();
            if lifecycle.wait_for_controller_release(platform, Duration::ZERO) {
                let _ = self.remove_managed_surface(&instance_id);
            }
        }
        let Some(role_id) = role_id else {
            return;
        };
        if role_already_fenced {
            self.discard_role_navigation_input_fences(&role_id);
        } else if let Err(error) = self.fence_closed_popup_input(window_label, &role_id) {
            self.emit_navigation_input_error(
                "SYSTEM_POPUP_INPUT_FENCE_FAILED",
                &error.message,
                &role_id,
                window_label,
            );
        }
        self.publish_projection();
    }

    fn fence_closed_popup_input(&self, window_label: &str, role_id: &str) -> RuntimeResult<()> {
        let local_epoch = self.advance_role_input_fence_local(role_id)?;
        let app = self.app.clone();
        let core = Arc::clone(&self.core);
        let role_id = role_id.to_owned();
        let window_label = window_label.to_owned();
        tauri::async_runtime::spawn(async move {
            let fenced = core
                .invoke_async(CoreCommand::MacroInputFence {
                    role_id: role_id.clone(),
                })
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok());
            let Some(fenced) = fenced else {
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    state.runtime.emit_navigation_input_error(
                        "SYSTEM_POPUP_INPUT_FENCE_FAILED",
                        "Popup close could not establish the Core input fence.",
                        &role_id,
                        &window_label,
                    );
                }
                return;
            };
            let epoch = fenced.input_epoch.max(local_epoch);
            if let Some(state) = app.try_state::<crate::CoreState>() {
                let _ = state.runtime.set_role_input_fence(&role_id, epoch);
            }
            let drained = core
                .invoke_async(CoreCommand::MacroInputDrain {
                    role_id: role_id.clone(),
                    input_epoch: fenced.input_epoch,
                })
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
                .is_some_and(|record| record.current);
            if !drained {
                return;
            }
            let resumed = core
                .invoke_async(CoreCommand::MacroInputResume {
                    role_id: role_id.clone(),
                    input_epoch: fenced.input_epoch,
                })
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
                .is_some_and(|record| record.current);
            if resumed
                && let Some(state) = app.try_state::<crate::CoreState>()
            {
                let _ = state.runtime.resume_role_input(&role_id, fenced.input_epoch);
            }
        });
        Ok(())
    }

    fn allow_navigation_after_macro_release(
        &self,
        webview_label: &str,
        role_id: &str,
        url: &Url,
    ) -> bool {
        if !matches!(url.scheme(), "about" | "http" | "https") {
            return false;
        }
        if should_release_macros_for_navigation(url) {
            let controlled = self.state.lock().is_ok_and(|state| {
                state.controlled_navigation_webviews.contains(webview_label)
            });
            if !controlled
                && let Err(error) = self.begin_navigation_input_fence(
                    webview_label,
                    role_id,
                    Some(url.as_str()),
                )
            {
                self.emit_navigation_input_error(
                    "SYSTEM_NAVIGATION_INPUT_FENCE_FAILED",
                    &error.message,
                    role_id,
                    webview_label,
                );
                return false;
            }
        }
        true
    }

    fn begin_navigation_input_fence(
        &self,
        webview_label: &str,
        role_id: &str,
        expected_url: Option<&str>,
    ) -> RuntimeResult<u64> {
        let epoch = serde_json::from_value::<MacroInputEpochRecord>(
            self.core
                .invoke(CoreCommand::MacroInputFence {
                    role_id: role_id.to_owned(),
                })
                .map_err(RuntimeError::core)?,
        )
        .map_err(|error| RuntimeError::new("SYSTEM_NAVIGATION_INPUT_FENCE_FAILED", error.to_string()))?
        .input_epoch;
        self.set_role_input_fence(role_id, epoch)?;
        {
            let mut state = self.state()?;
            update_navigation_input_fences(
                &mut state.navigation_input_fences,
                webview_label,
                role_id,
                epoch,
                expected_url,
            );
        }
        let app = self.app.clone();
        let core = Arc::clone(&self.core);
        let role_id = role_id.to_owned();
        let webview_label = webview_label.to_owned();
        tauri::async_runtime::spawn(async move {
            match core
                .invoke_async(CoreCommand::MacroInputDrain {
                    role_id: role_id.clone(),
                    input_epoch: epoch,
                })
                .await
            {
                Ok(_) => {
                    if let Some(state) = app.try_state::<crate::CoreState>() {
                        state.runtime.finish_navigation_input_drain(
                            &webview_label,
                            &role_id,
                            epoch,
                        );
                    }
                }
                Err(error) => {
                    if let Some(state) = app.try_state::<crate::CoreState>() {
                        state.runtime.emit_navigation_input_error(
                            "SYSTEM_NAVIGATION_INPUT_DRAIN_FAILED",
                            &error.to_string(),
                            &role_id,
                            &webview_label,
                        );
                    }
                }
            }
        });
        Ok(epoch)
    }

    fn current_navigation_input_epoch(
        &self,
        webview_label: &str,
        role_id: &str,
    ) -> Option<u64> {
        self.state.lock().ok().and_then(|state| {
            state
                .navigation_input_fences
                .get(webview_label)
                .filter(|ticket| ticket.role_id == role_id)
                .map(|ticket| ticket.input_epoch)
        })
    }

    fn finish_navigation_input_drain(
        &self,
        webview_label: &str,
        role_id: &str,
        input_epoch: u64,
    ) {
        let current = self.current_navigation_input_epoch(webview_label, role_id);
        if current != Some(input_epoch) {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            mark_navigation_input_drained(
                &mut state.navigation_input_fences,
                role_id,
                input_epoch,
            );
        }
        self.try_resume_navigation_input(role_id, input_epoch);
    }

    fn finish_navigation_page(&self, webview_label: &str, url: &Url) {
        let ticket = self.state.lock().ok().and_then(|mut state| {
            mark_navigation_page_finished(
                &mut state.navigation_input_fences,
                webview_label,
                url.as_str(),
            )
        });
        if let Some((role_id, input_epoch)) = ticket {
            self.try_resume_navigation_input(&role_id, input_epoch);
        }
    }

    fn try_resume_navigation_input(&self, role_id: &str, input_epoch: u64) {
        let ready = self.state.lock().is_ok_and(|mut state| {
            if !navigation_input_is_ready(
                &state.navigation_input_fences,
                role_id,
                input_epoch,
            ) {
                return false;
            }
            state
                .navigation_input_fences
                .retain(|_, ticket| ticket.role_id != role_id);
            true
        });
        if !ready {
            return;
        }
        let resumed = self
            .core
            .invoke(CoreCommand::MacroInputResume {
                role_id: role_id.to_owned(),
                input_epoch,
            })
            .ok()
            .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
            .is_some_and(|record| record.current);
        if resumed {
            let _ = self.resume_role_input(role_id, input_epoch);
        }
    }

    fn emit_navigation_input_error(
        &self,
        code: &str,
        message: &str,
        role_id: &str,
        webview_label: &str,
    ) {
        let _ = self.app.emit(
            "rion://shell-error",
            json!({
                "code": code,
                "message": message,
                "roleId": role_id,
                "webviewLabel": webview_label
            }),
        );
    }

    fn discard_role_navigation_input_fences(&self, role_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state
                .navigation_input_fences
                .retain(|_, ticket| ticket.role_id != role_id);
        }
    }

    #[cfg(windows)]
    fn should_defer_windows_document_navigation(&self, webview_label: &str) -> bool {
        self.state.lock().is_ok_and(|state| {
            should_defer_document_navigation(
                "windows",
                state.controlled_navigation_webviews.contains(webview_label),
            )
        })
    }

    fn begin_controlled_navigation(&self, webview_label: &str) -> RuntimeResult<()> {
        self.state()?
            .controlled_navigation_webviews
            .insert(webview_label.to_owned());
        Ok(())
    }

    fn finish_controlled_navigations(&self, webview_labels: &[String]) {
        if let Ok(mut state) = self.state.lock() {
            for label in webview_labels {
                state.controlled_navigation_webviews.remove(label);
            }
        }
    }

    fn register_popup(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        window_label: String,
        role_id: String,
        generation: u64,
    ) -> RuntimeResult<()> {
        let (tab_id, window_id, effective_zoom) = {
            let mut state = self.state()?;
            let tab_id = state.role_tabs.get(&role_id).cloned().ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_ROLE_NOT_FOUND",
                    "Runtime role was not found while registering its popup.",
                )
            })?;
            let tab = state.tabs.get(&tab_id).ok_or_else(|| {
                RuntimeError::new(
                    "TAURI_RUNTIME_TAB_NOT_FOUND",
                    "Runtime tab was not found while registering its popup.",
                )
            })?;
            let role_zoom = tab
                .roles
                .get(&role_id)
                .map(|role| role.zoom_factor)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role surface was not found while registering its popup.",
                    )
                })?;
            let window_id = tab.window_id.clone();
            let window_zoom = state
                .display_hosts
                .get(&window_id)
                .map(|host| host.zoom_factor)
                .unwrap_or(1.0);
            state
                .popup_roles
                .insert(window_label.clone(), role_id.clone());
            (
                tab_id,
                window_id,
                effective_zoom_factor(role_zoom, window_zoom),
            )
        };
        if let Err(error) = self.register_managed_surface(
            webview,
            lifecycle,
            ManagedSurfaceKind::Popup,
            ManagedSurfacePhase::Live,
            Some(&role_id),
            Some(&tab_id),
            &window_id,
            generation,
        ) {
            if let Ok(mut state) = self.state.lock() {
                state.popup_roles.remove(&window_label);
            }
            return Err(error);
        }
        webview
            .set_zoom(effective_zoom)
            .map_err(RuntimeError::tauri)
    }

    fn schedule_surface_recovery(
        self: &Arc<Self>,
        role_id: String,
        reason: String,
        generation: u64,
    ) {
        if !self.health.is_healthy() {
            return;
        }
        let allowed = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.close_coordinator.closing_roles.contains(&role_id)
                || state.close_coordinator.quarantined_roles.contains(&role_id)
            {
                return;
            }
            let Some(tab_id) = state.role_tabs.get(&role_id) else {
                return;
            };
            let Some(surface_generation) = state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(&role_id))
                .map(|surface| surface.generation)
            else {
                return;
            };
            if !claim_surface_recovery(
                surface_generation,
                generation,
                &mut state.recovering_roles,
                &role_id,
            ) {
                return;
            }
            let now = Instant::now();
            let budget = state
                .recovery_budgets
                .entry(role_id.clone())
                .or_insert(RecoveryBudget {
                    attempts: 0,
                    window_started: now,
                });
            budget.claim(now)
        };
        let queued = self.effect_sender.get().ok_or(()).and_then(|sender| {
            sender
                .send(SystemRuntimeWork::RecoverSurface {
                    allowed,
                    reason: reason.clone(),
                    role_id: role_id.clone(),
                })
                .map_err(|_| ())
        });
        if queued.is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            let _ = self.app.emit(
                "rion://shell-error",
                json!({
                    "code": "SYSTEM_SURFACE_RECOVERY_QUEUE_UNAVAILABLE",
                    "message": "The System WebView recovery queue is unavailable. Restart Rion Studio to recover safely.",
                    "roleId": role_id,
                    "reason": reason
                }),
            );
        }
    }

    fn recover_system_surface(&self, role_id: String, reason: String, allowed: bool) {
        if self.state.lock().ok().is_some_and(|mut state| {
            let fenced = state.close_coordinator.closing_roles.contains(&role_id)
                || state.close_coordinator.quarantined_roles.contains(&role_id);
            if fenced {
                state.recovering_roles.remove(&role_id);
            }
            fenced
        }) {
            return;
        }
        let recovery_epoch = self
            .core
            .invoke(CoreCommand::MacroInputFence {
                role_id: role_id.clone(),
            })
            .ok()
            .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
            .map(|record| record.input_epoch);
        let Some(recovery_epoch) = recovery_epoch else {
            self.emit_navigation_input_error(
                "SYSTEM_SURFACE_RECOVERY_INPUT_FENCE_FAILED",
                "System WebView recovery could not establish an input fence.",
                &role_id,
                "recovery",
            );
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            return;
        };
        if let Err(error) = self.set_role_input_fence(&role_id, recovery_epoch) {
            self.emit_navigation_input_error(
                "SYSTEM_SURFACE_RECOVERY_INPUT_FENCE_FAILED",
                &error.message,
                &role_id,
                "recovery",
            );
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            return;
        }
        let drained = self
            .core
            .invoke(CoreCommand::MacroInputDrain {
                role_id: role_id.clone(),
                input_epoch: recovery_epoch,
            })
            .ok()
            .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
            .is_some_and(|record| record.current);
        if !drained {
            self.emit_navigation_input_error(
                "SYSTEM_SURFACE_RECOVERY_INPUT_DRAIN_FAILED",
                "System WebView recovery could not confirm that macro input drained.",
                &role_id,
                "recovery",
            );
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            return;
        }
        self.clear_role_keys(&role_id);
        let _ = self.core.invoke(CoreCommand::EmbeddedSystemSurfaceFailed {
            role_id: role_id.clone(),
            reason: Some(reason.clone()),
        });
        let result = if allowed {
            self.rebuild_role_surface(&role_id)
        } else {
            Err(RuntimeError::new(
                "SYSTEM_SURFACE_RECOVERY_EXHAUSTED",
                "System WebView recovery was stopped after two failures within 60 seconds.",
            ))
        };
        match result {
            Ok(()) => {
                let recovered = self
                    .core
                    .invoke(CoreCommand::EmbeddedSystemSurfaceRecovered {
                        role_id: role_id.clone(),
                    })
                    .is_ok();
                let resumed = recovered
                    && self
                        .core
                        .invoke(CoreCommand::MacroInputResume {
                            role_id: role_id.clone(),
                            input_epoch: recovery_epoch,
                        })
                        .ok()
                        .and_then(|value| {
                            serde_json::from_value::<MacroInputEpochRecord>(value).ok()
                        })
                        .is_some_and(|record| record.current);
                if resumed {
                    let _ = self.resume_role_input(&role_id, recovery_epoch);
                } else {
                    self.emit_navigation_input_error(
                        "SYSTEM_SURFACE_RECOVERY_INPUT_RESUME_FAILED",
                        "The recovered page remains visible, but automatic input is disabled until the role restarts.",
                        &role_id,
                        "recovery",
                    );
                }
                self.publish_projection();
            }
            Err(error) => {
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": error.code,
                        "message": error.message,
                        "roleId": role_id,
                        "reason": reason
                    }),
                );
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.recovering_roles.remove(&role_id);
        }
    }

}

fn update_navigation_input_fences(
    tickets: &mut HashMap<String, NavigationInputFence>,
    webview_label: &str,
    role_id: &str,
    input_epoch: u64,
    expected_url: Option<&str>,
) {
    for ticket in tickets
        .values_mut()
        .filter(|ticket| ticket.role_id == role_id)
    {
        ticket.input_epoch = input_epoch;
        ticket.drained = false;
    }
    tickets.insert(
        webview_label.to_owned(),
        NavigationInputFence {
            role_id: role_id.to_owned(),
            input_epoch,
            expected_url: expected_url.map(str::to_owned),
            drained: false,
            page_finished: false,
        },
    );
}

fn mark_navigation_input_drained(
    tickets: &mut HashMap<String, NavigationInputFence>,
    role_id: &str,
    input_epoch: u64,
) {
    for ticket in tickets
        .values_mut()
        .filter(|ticket| ticket.role_id == role_id && ticket.input_epoch == input_epoch)
    {
        ticket.drained = true;
    }
}

fn mark_navigation_page_finished(
    tickets: &mut HashMap<String, NavigationInputFence>,
    webview_label: &str,
    url: &str,
) -> Option<(String, u64)> {
    let ticket = tickets.get_mut(webview_label)?;
    if ticket
        .expected_url
        .as_deref()
        .is_some_and(|expected| expected != url)
    {
        return None;
    }
    ticket.page_finished = true;
    Some((ticket.role_id.clone(), ticket.input_epoch))
}

fn navigation_input_is_ready(
    tickets: &HashMap<String, NavigationInputFence>,
    role_id: &str,
    input_epoch: u64,
) -> bool {
    let mut role_tickets = tickets
        .values()
        .filter(|ticket| ticket.role_id == role_id)
        .peekable();
    role_tickets.peek().is_some()
        && role_tickets.all(|ticket| {
            ticket.input_epoch == input_epoch && ticket.drained && ticket.page_finished
        })
}
