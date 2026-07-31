impl SystemRuntimeExecutor {
    fn schedule_window_placement_persistence(self: &Arc<Self>, label: String) {
        let sequence = WINDOW_PLACEMENT_PERSIST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let should_spawn = self.state.lock().ok().is_some_and(|mut state| {
            let suppressed = state.display_hosts.iter().any(|(window_id, host)| {
                host.window.label() == label
                    && state
                        .tab_drag_placement_suppressed_windows
                        .contains(window_id)
            });
            if suppressed {
                return false;
            }
            state
                .pending_window_placement_writes
                .insert(label.clone(), sequence);
            state.active_window_placement_workers.insert(label.clone())
        });
        if !should_spawn {
            return;
        }
        let runtime = Arc::clone(self);
        let worker_label = label.clone();
        let spawn_result = thread::Builder::new()
            .name("rion-runtime-window-placement".to_owned())
            .spawn(move || {
                let mut observed = sequence;
                loop {
                    thread::sleep(WINDOW_PLACEMENT_PERSIST_DEBOUNCE);
                    let settled = runtime.state.lock().ok().is_none_or(|mut state| {
                        let current = state
                            .pending_window_placement_writes
                            .get(&worker_label)
                            .copied();
                        if current.is_some_and(|current| current != observed) {
                            observed = current.expect("checked placement sequence");
                            return false;
                        }
                        state.pending_window_placement_writes.remove(&worker_label);
                        state.active_window_placement_workers.remove(&worker_label);
                        true
                    });
                    if !settled {
                        continue;
                    }
                    let suppressed = runtime.state.lock().ok().is_some_and(|state| {
                        state.display_hosts.iter().any(|(window_id, host)| {
                            host.window.label() == worker_label
                                && state
                                    .tab_drag_placement_suppressed_windows
                                    .contains(window_id)
                        })
                    });
                    if suppressed {
                        break;
                    }
                    if let Err(error) = runtime.persist_game_window_placement(&worker_label) {
                        runtime.emit_runtime_shell_error(
                            "TAURI_RUNTIME_WINDOW_PERSIST_FAILED",
                            error,
                            &worker_label,
                        );
                    }
                    break;
                }
            });
        if spawn_result.is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.active_window_placement_workers.remove(&label);
                state.pending_window_placement_writes.remove(&label);
            }
            if let Err(error) = self.persist_game_window_placement(&label) {
                self.emit_runtime_shell_error("TAURI_RUNTIME_WINDOW_PERSIST_FAILED", error, &label);
            }
        }
    }

    fn emit_runtime_shell_error(&self, code: &str, message: String, label: &str) {
        let _ = self.app.emit(
            "rion://shell-error",
            json!({ "code": code, "message": message, "windowLabel": label }),
        );
    }

    #[cfg(target_os = "macos")]
    pub fn prepare_runtime_window_fullscreen(&self, label: &str, fullscreen: bool) {
        let controller = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .values()
                .find(|host| host.window.label() == label)
                .map(|host| host.tabs_controller.clone())
        });
        if let Some(controller) = controller {
            controller.prepare_fullscreen(fullscreen);
        }
    }

    pub fn persist_restore_session(&self, clean_exit: bool) -> Result<(), String> {
        let mut session = self
            .core
            .invoke(CoreCommand::RuntimeRestoreSessionGet)
            .map_err(|error| error.to_string())
            .and_then(|value| {
                serde_json::from_value::<RuntimeRestoreSessionRecord>(value)
                    .map_err(|error| error.to_string())
            })?;
        prepare_restore_session_for_persist(&mut session, clean_exit);
        self.core
            .invoke(CoreCommand::RuntimeRestoreSessionReplace { session })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn take_macro_page_request(&self) -> Option<Value> {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_macro_page_request.take())
    }

    pub fn refresh_macro_overlays(&self, role_ids: &[String]) {
        let (mut webviews, popup_labels) = {
            let Ok(state) = self.state.lock() else {
                return;
            };
            let webviews = state
                .tabs
                .values()
                .flat_map(|tab| tab.roles.iter())
                .filter(|(role_id, _)| should_refresh_macro_overlay(role_ids, role_id))
                .map(|(_, surface)| surface.webview.clone())
                .collect::<Vec<_>>();
            let popup_labels = state
                .popup_roles
                .iter()
                .filter(|(_, role_id)| should_refresh_macro_overlay(role_ids, role_id))
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            (webviews, popup_labels)
        };

        for label in popup_labels {
            if let Some(webview) = self.app.get_webview(&label) {
                webviews.push(webview);
            }
        }
        refresh_macro_overlay_handles(webviews, |webview| {
            webview.eval(MACRO_OVERLAY_REFRESH_SOURCE)
        });
    }

    pub fn refresh_browser_fonts(&self) {
        let (mut webviews, popup_labels) = {
            let Ok(state) = self.state.lock() else {
                return;
            };
            let webviews = state
                .tabs
                .values()
                .flat_map(|tab| tab.roles.values())
                .map(|surface| surface.webview.clone())
                .collect::<Vec<_>>();
            let popup_labels = state.popup_roles.keys().cloned().collect::<Vec<_>>();
            (webviews, popup_labels)
        };

        for label in popup_labels {
            if let Some(webview) = self.app.get_webview(&label) {
                webviews.push(webview);
            }
        }
        refresh_macro_overlay_handles(webviews, |webview| {
            webview.eval(BROWSER_FONTS_REFRESH_SOURCE)
        });
    }

    pub fn role_id_for_webview(&self, webview_label: &str) -> Result<String, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        if state
            .close_coordinator
            .closing_webviews
            .contains(webview_label)
        {
            return Err("Overlay WebView is closing.".to_owned());
        }
        if let Some(role_id) = state.popup_roles.get(webview_label) {
            if state.close_coordinator.closing_roles.contains(role_id) {
                return Err("Overlay role is closing.".to_owned());
            }
            return Ok(role_id.clone());
        }
        state
            .role_tabs
            .iter()
            .find_map(|(role_id, tab_id)| {
                state.tabs.get(tab_id).and_then(|tab| {
                    tab.roles
                        .get(role_id)
                        .filter(|surface| {
                            surface.webview.label() == webview_label
                                && !state.close_coordinator.closing_roles.contains(role_id)
                        })
                        .map(|_| role_id.clone())
                })
            })
            .ok_or_else(|| "Overlay WebView is not associated with a running role.".to_owned())
    }

    pub fn authorize_overlay_request(
        &self,
        webview_label: &str,
        capability: &str,
    ) -> Result<String, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        if state
            .close_coordinator
            .closing_webviews
            .contains(webview_label)
        {
            return Err("The overlay WebView is closing.".to_owned());
        }
        if state
            .overlay_capabilities
            .get(webview_label)
            .map(String::as_str)
            != Some(capability)
        {
            return Err("The overlay capability is missing or no longer valid.".to_owned());
        }
        if let Some(role_id) = state.popup_roles.get(webview_label) {
            if state.close_coordinator.closing_roles.contains(role_id) {
                return Err("The overlay role is closing.".to_owned());
            }
            return Ok(role_id.clone());
        }
        state
            .role_tabs
            .iter()
            .find_map(|(role_id, tab_id)| {
                state.tabs.get(tab_id).and_then(|tab| {
                    tab.roles
                        .get(role_id)
                        .filter(|surface| {
                            surface.webview.label() == webview_label
                                && !state.close_coordinator.closing_roles.contains(role_id)
                        })
                        .map(|_| role_id.clone())
                })
            })
            .ok_or_else(|| "Overlay WebView is not associated with a running role.".to_owned())
    }

    pub fn mark_overlay_ready(&self, webview_label: &str, capability: &str) -> Result<(), String> {
        self.authorize_overlay_request(webview_label, capability)?;
        let inserted = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .overlay_ready_webviews
            .insert(webview_label.to_owned());
        if inserted {
            self.record_runtime_stage(
                format!("overlay-ready:{webview_label}"),
                "completed",
                Instant::now(),
            );
        }
        Ok(())
    }

    fn overlay_document_start_script_for_label(&self, label: &str) -> RuntimeResult<String> {
        let capability = {
            let mut state = self.state()?;
            state
                .overlay_capabilities
                .entry(label.to_owned())
                .or_insert_with(|| uuid::Uuid::new_v4().to_string())
                .clone()
        };
        macro_overlay_document_start_script(
            &self.configuration.overlay_document_start_script_template,
            &capability,
        )
        .map_err(|message| RuntimeError::new("SYSTEM_OVERLAY_SCRIPT_INVALID", message))
    }

    fn revoke_overlay_capability(&self, label: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.overlay_capabilities.remove(label);
            state.overlay_ready_webviews.remove(label);
        }
    }

    #[cfg(target_os = "macos")]
    fn failure_target_for_webview(&self, webview_label: &str) -> Option<SurfaceFailureTarget> {
        let state = self.state.lock().ok()?;
        if let Some(role_id) = state.popup_roles.get(webview_label) {
            let tab_id = state.role_tabs.get(role_id)?;
            let generation = state.tabs.get(tab_id)?.roles.get(role_id)?.generation;
            return Some(SurfaceFailureTarget::Popup {
                label: webview_label.to_owned(),
                role_id: role_id.clone(),
                generation,
            });
        }
        state.role_tabs.iter().find_map(|(role_id, tab_id)| {
            state.tabs.get(tab_id).and_then(|tab| {
                tab.roles
                    .get(role_id)
                    .filter(|surface| surface.webview.label() == webview_label)
                    .map(|surface| SurfaceFailureTarget::Role {
                        role_id: role_id.clone(),
                        generation: surface.generation,
                    })
            })
        })
    }

    fn claim_surface_generation(&self, role_id: &str) -> RuntimeResult<u64> {
        let mut state = self.state()?;
        let generation = state
            .recovery_generations
            .entry(role_id.to_owned())
            .or_insert(0);
        *generation = generation.saturating_add(1);
        Ok(*generation)
    }

    fn surface_generation_for_role(&self, role_id: &str) -> Option<u64> {
        let state = self.state.lock().ok()?;
        if state.close_coordinator.closing_roles.contains(role_id) {
            return None;
        }
        let tab_id = state.role_tabs.get(role_id)?;
        state
            .tabs
            .get(tab_id)?
            .roles
            .get(role_id)
            .map(|surface| surface.generation)
    }

    pub fn zoom_role_for_webview(
        self: &Arc<Self>,
        webview_label: &str,
        action: &str,
    ) -> Result<u32, String> {
        if !matches!(action, "in" | "out" | "reset") {
            return Err("Role zoom action is invalid.".to_owned());
        }
        let role_id = self.role_id_for_webview(webview_label)?;
        let (
            tab_id,
            workspace_id,
            persist_saved_zoom,
            window_zoom_factor,
            previous_base_zoom_factor,
            base_zoom_factor,
            webviews,
        ) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let tab_id = state
                .role_tabs
                .get(&role_id)
                .cloned()
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let tab = state
                .tabs
                .get(&tab_id)
                .ok_or_else(|| "Runtime tab was not found.".to_owned())?;
            let surface = tab
                .roles
                .get(&role_id)
                .ok_or_else(|| "Runtime role was not found.".to_owned())?;
            let window_zoom_factor = state
                .display_hosts
                .get(&tab.window_id)
                .map(|host| host.zoom_factor)
                .unwrap_or(1.0);
            let mut webviews = vec![surface.webview.clone()];
            webviews.extend(
                state
                    .popup_roles
                    .iter()
                    .filter_map(|(label, popup_role_id)| {
                        (popup_role_id == &role_id)
                            .then(|| self.app.get_webview(label))
                            .flatten()
                    }),
            );
            (
                tab_id,
                tab.workspace_id.clone(),
                should_persist_role_zoom(&state.saved_window_names, &tab.window_id),
                window_zoom_factor,
                surface.zoom_factor,
                next_zoom_factor(surface.zoom_factor, action, 0.25, 3.0),
                webviews,
            )
        };
        let previous_effective_zoom =
            effective_zoom_factor(previous_base_zoom_factor, window_zoom_factor);
        let effective_zoom = effective_zoom_factor(base_zoom_factor, window_zoom_factor);
        if let Err(failure) = apply_reversible_fanout(
            &webviews,
            |index, webview| {
                webview
                    .set_zoom(effective_zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
            |index, webview| {
                webview
                    .set_zoom(previous_effective_zoom)
                    .map_err(|error| format!("surface {index}: {error}"))
            },
        ) {
            if !failure.rollback_errors.is_empty() {
                self.health.mark_unhealthy();
            }
            return Err(reversible_fanout_runtime_error(
                "TAURI_RUNTIME_ZOOM_FAILED",
                "Updating role zoom",
                &failure,
            )
            .message);
        }
        let commit = (|| -> Result<(), String> {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let surface = state
                .tabs
                .get_mut(&tab_id)
                .and_then(|tab| tab.roles.get_mut(&role_id))
                .ok_or_else(|| "Runtime role stopped while zooming.".to_owned())?;
            if surface.zoom_factor != previous_base_zoom_factor {
                return Err("Runtime role zoom changed concurrently.".to_owned());
            }
            surface.zoom_factor = base_zoom_factor;
            surface.zoom_mode = "fixed".to_owned();
            Ok(())
        })();
        if let Err(error) = commit {
            let rollback_errors = rollback_reversible_fanout(&webviews, |index, webview| {
                webview
                    .set_zoom(previous_effective_zoom)
                    .map_err(|rollback_error| format!("surface {index}: {rollback_error}"))
            });
            if !rollback_errors.is_empty() {
                self.health.mark_unhealthy();
                return Err(format!(
                    "{error} Native zoom compensation also failed: {}. Restart Rion Studio to recover safely.",
                    rollback_errors.join("; ")
                ));
            }
            return Err(error);
        }
        let percent = (base_zoom_factor * 100.0).round() as u32;
        if let Some(source) = webviews
            .iter()
            .find(|webview| webview.label() == webview_label)
            .or_else(|| webviews.first())
        {
            show_zoom_indicator(source, &format!("{percent}%"));
        }
        if persist_saved_zoom {
            self.persist_runtime_tab_role_views(&tab_id)?;
            if let Some(workspace_id) = workspace_id {
                self.schedule_role_zoom_persistence(workspace_id, role_id, percent);
            }
        }
        Ok(percent)
    }

    fn schedule_role_zoom_persistence(
        self: &Arc<Self>,
        workspace_id: String,
        role_id: String,
        percent: u32,
    ) {
        let sequence = ROLE_ZOOM_PERSIST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let key = (workspace_id.clone(), role_id.clone());
        if let Ok(mut state) = self.state.lock() {
            state.pending_role_zoom_writes.insert(key.clone(), sequence);
        }
        let runtime = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let should_write = runtime.state.lock().ok().is_some_and(|mut state| {
                take_latest_role_zoom_write(&mut state.pending_role_zoom_writes, &key, sequence)
            });
            if !should_write {
                return;
            }
            if let Err(error) = runtime
                .core
                .invoke_async(CoreCommand::WorkspaceSetRoleBrowserZoom {
                    workspace_id: workspace_id.clone(),
                    role_id: role_id.clone(),
                    browser_zoom_percent: percent as f64,
                })
                .await
            {
                let _ = runtime.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "TAURI_ROLE_ZOOM_PERSIST_FAILED",
                        "message": error.to_string(),
                        "workspaceId": workspace_id,
                        "roleId": role_id,
                        "browserZoomPercent": percent
                    }),
                );
            }
        });
    }

    pub fn set_webview_audible(
        &self,
        webview_label: &str,
        role_id: &str,
        audible: bool,
    ) -> Result<(), String> {
        let changed = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            let belongs_to_role = state
                .popup_roles
                .get(webview_label)
                .is_some_and(|id| id == role_id)
                || state.role_tabs.get(role_id).is_some_and(|tab_id| {
                    state.tabs.get(tab_id).is_some_and(|tab| {
                        tab.roles
                            .get(role_id)
                            .is_some_and(|surface| surface.webview.label() == webview_label)
                    })
                });
            if !belongs_to_role {
                return Err("Audio state source is not associated with this role.".to_owned());
            }
            let previous = state
                .audible_webviews
                .get(webview_label)
                .copied()
                .unwrap_or(false);
            if audible {
                state
                    .audible_webviews
                    .insert(webview_label.to_owned(), true);
            } else {
                state.audible_webviews.remove(webview_label);
            }
            previous != audible
        };
        if changed {
            self.publish_projection();
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn handle_web_content_process_terminated(
        self: &Arc<Self>,
        webview_label: &str,
        reason: &str,
    ) {
        let Some(target) = self.failure_target_for_webview(webview_label) else {
            return;
        };
        self.handle_surface_process_failure(
            target,
            reason.to_owned(),
            SurfaceFailureScope::Renderer,
        );
    }

    fn handle_surface_process_failure(
        self: &Arc<Self>,
        target: SurfaceFailureTarget,
        reason: String,
        scope: SurfaceFailureScope,
    ) {
        match surface_failure_action(&target, scope) {
            SurfaceFailureAction::RecoverRole => {
                let (role_id, generation) = match target {
                    SurfaceFailureTarget::Role {
                        role_id,
                        generation,
                    }
                    | SurfaceFailureTarget::Popup {
                        role_id,
                        generation,
                        ..
                    } => (role_id, generation),
                };
                self.schedule_surface_recovery(role_id, reason, generation);
            }
            SurfaceFailureAction::ClosePopup => {
                let SurfaceFailureTarget::Popup {
                    label,
                    role_id,
                    generation,
                } = target
                else {
                    return;
                };
                self.close_failed_popup(&label, &role_id, generation, &reason);
            }
        }
    }

    fn close_failed_popup(&self, label: &str, role_id: &str, generation: u64, reason: &str) {
        let current = self.state.lock().ok().is_some_and(|state| {
            state.popup_roles.get(label).map(String::as_str) == Some(role_id)
                && state.role_tabs.get(role_id).is_some_and(|tab_id| {
                    state
                        .tabs
                        .get(tab_id)
                        .and_then(|tab| tab.roles.get(role_id))
                        .is_some_and(|surface| surface.generation == generation)
                })
        });
        if !current {
            return;
        }

        let close_error = self
            .app
            .get_webview_window(label)
            .map(|window| window.close().map_err(|error| error.to_string()))
            .unwrap_or(Ok(()))
            .err();
        if close_error.is_none() {
            self.forget_popup(label);
        }
        let _ = self.app.emit(
            "rion://shell-error",
            json!({
                "code": "SYSTEM_POPUP_PROCESS_FAILED",
                "message": "A popup WebView process failed and the popup was isolated from its healthy role surface.",
                "roleId": role_id,
                "webviewLabel": label,
                "reason": reason,
                "closeError": close_error
            }),
        );
    }

}
