impl SystemRuntimeExecutor {
    fn apply(
        &self,
        effect: CoreEffectRequest,
        presentation_revision: u64,
    ) -> RuntimeResult<Option<String>> {
        match effect.action {
            CoreEffectAction::LocalStorageSyncRefresh {
                source_role_id,
                source_launch_url,
                origin,
                keys,
            } => {
                self.refresh_local_storage_sync_source(
                    &source_role_id,
                    &source_launch_url,
                    &origin,
                    &keys,
                )?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedCreateTab { tab } => self.create_tab(*tab).map(|()| None),
            CoreEffectAction::EmbeddedConfigureRoleSessions { role_ids } => {
                self.require_roles(&role_ids)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedLoadRoles { roles } => {
                self.load_roles(roles)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedInstallOverlays { role_ids } => {
                self.install_overlays(&role_ids)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedFocusRole {
                role_id,
                zoom_factor,
            } => {
                self.focus_role(&role_id, zoom_factor)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedDestroyRole { role_id } => {
                self.destroy_role(&role_id)?;
                Ok(None)
            }
            CoreEffectAction::EmbeddedDestroyTab {
                tab_id,
                next_active_tab_id,
            } => {
                let completed_failed_launch_cleanup = {
                    let mut state = self.state()?;
                    let completed = consume_completed_failed_launch_cleanup(&mut state, &tab_id);
                    if completed {
                        state.retryable_failed_launches.insert(tab_id.clone());
                    }
                    completed
                };
                if completed_failed_launch_cleanup {
                    self.record_presentation_event(
                        LogLevel::Debug,
                        "tab.launch-cleanup-compensation-noop",
                        "A failed launch had already completed verified native cleanup.",
                        "",
                        Some(&tab_id),
                        presentation_revision,
                        "compensation",
                        0,
                    );
                } else {
                    let window_id = self
                        .state()
                        .ok()
                        .and_then(|state| {
                            state
                                .tabs
                                .get(&tab_id)
                                .map(|tab| tab.window_id.clone())
                                .or_else(|| {
                                    next_active_tab_id.as_deref().and_then(|next_tab_id| {
                                        state.tabs.get(next_tab_id).map(|tab| tab.window_id.clone())
                                    })
                                })
                        })
                        .unwrap_or_default();
                    if let Err(error) = self
                        .prepare_destroy_tab_presentation(&tab_id, next_active_tab_id.as_deref())
                    {
                        self.record_presentation_event_with_error(
                            LogLevel::Warn,
                            "tab.close-successor-preflight-failed",
                            "The close successor could not be presented before native teardown.",
                            &window_id,
                            next_active_tab_id.as_deref().or(Some(tab_id.as_str())),
                            presentation_revision,
                            "close-effect-preflight",
                            0,
                            Some(&rion_core::CoreErrorPayload {
                                code: error.code.to_owned(),
                                message: error.message.clone(),
                            }),
                        );
                    }
                    self.destroy_tab(&tab_id)?;
                }
                Ok(None)
            }
            CoreEffectAction::EmbeddedApplyRuntime {
                snapshot,
                target,
                reveal_window_ids,
                focus_window_ids,
                focus_tab_id,
            } => {
                self.apply_runtime(
                    snapshot,
                    target,
                    &reveal_window_ids,
                    &focus_window_ids,
                    focus_tab_id.as_deref(),
                    presentation_revision,
                )?;
                Ok(None)
            }
            CoreEffectAction::RoleBrowserDataClearSession {
                role_id,
                origin,
                local_storage_sync_keys,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => {
                self.clear_role_browser_data(
                    &role_id,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                )?;
                self.local_storage_sync_source_cleared(
                    &role_id,
                    &origin,
                    &local_storage_sync_keys,
                )?;
                Ok(None)
            }
            CoreEffectAction::ChromeProfileImportSnapshot {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
                replace_existing,
            } => {
                self.snapshot_role_session_transfer(
                    &transaction_id,
                    &role_id,
                    &launch_url,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                    replace_existing,
                )?;
                Ok(None)
            }
            CoreEffectAction::ChromeProfileImportApply {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
                replace_existing,
            } => {
                let payload = self.load_session_transfer(&transaction_id)?;
                let (inserted_cookie_count, backup) =
                    self.apply_role_session_transfer(RoleSessionTransferRequest {
                        role_id: &role_id,
                        launch_url: &launch_url,
                        webview2_user_data_dir: &webview2_user_data_dir,
                        webkit_data_store_identifier: &webkit_data_store_identifier,
                        replace_existing,
                        payload,
                        backup_transaction_id: Some(&transaction_id),
                    })?;
                self.state()?
                    .session_import_backups
                    .insert(transaction_id, backup);
                Ok(Some(
                    json!({ "insertedCookieCount": inserted_cookie_count }).to_string(),
                ))
            }
            CoreEffectAction::ChromeProfileImportVerify {
                role_id,
                verification_url,
                authenticated_path,
                login_path,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => self.verify_role_authentication(
                &role_id,
                &verification_url,
                &authenticated_path,
                &login_path,
                &webview2_user_data_dir,
                &webkit_data_store_identifier,
            ),
            CoreEffectAction::ChromeProfileImportRollback {
                transaction_id,
                role_id,
                launch_url,
                webview2_user_data_dir,
                webkit_data_store_identifier,
            } => {
                self.rollback_role_session_transfer(
                    &transaction_id,
                    &role_id,
                    &launch_url,
                    &webview2_user_data_dir,
                    &webkit_data_store_identifier,
                )?;
                Ok(None)
            }
            CoreEffectAction::ChromeProfileImportCommit { transaction_id } => {
                self.commit_role_session_transfer(&transaction_id)?;
                Ok(None)
            }
            CoreEffectAction::OverlayOpenMacroPage { role_id } => {
                let request = json!({ "roleId": role_id });
                {
                    self.state()?.pending_macro_page_request = Some(request.clone());
                }
                let dispatch_app = self.app.clone();
                let window_app = dispatch_app.clone();
                dispatch_app
                    .run_on_main_thread(move || {
                        if let Some(window) = window_app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = window_app.emit("rion://macro-page-request", request);
                    })
                    .map_err(RuntimeError::tauri)?;
                Ok(None)
            }
            CoreEffectAction::OverlayCopyCoordinate { coordinate } => {
                crate::native_shell::copy_text(&format!(
                    "X: {}px ({}%), Y: {}px ({}%), Viewport: {}x{}px",
                    coordinate.x_px,
                    coordinate.x_percent,
                    coordinate.y_px,
                    coordinate.y_percent,
                    coordinate.viewport_width_px,
                    coordinate.viewport_height_px
                ))
                .map_err(|message| RuntimeError::new("SHELL_CLIPBOARD_FAILED", message))?;
                Ok(None)
            }
            CoreEffectAction::BrowserAction { request } => self.browser_action(*request),
        }
    }

    fn browser_action(&self, request: BrowserActionRequest) -> RuntimeResult<Option<String>> {
        if request.request_id.is_empty() || request.role_id.is_empty() {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_INVALID",
                "Browser action identifiers are required.",
            ));
        }
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        if now_ms > request.deadline_ms {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_DEADLINE",
                "Browser action deadline expired.",
            ));
        }
        match request.action {
            BrowserAction::Focus => {
                self.prepare_automation_focus(&request.role_id)?;
                Ok(None)
            }
            BrowserAction::Key {
                phase,
                key,
                code,
                modifiers,
                owner_id,
                suppress_overlay_shortcut: _,
            } => {
                let code = code.filter(|value| !value.is_empty()).unwrap_or(key);
                self.dispatch_key_action(&request.role_id, &phase, &code, &modifiers, &owner_id)?;
                Ok(None)
            }
            BrowserAction::Click {
                anchor,
                unit,
                x,
                y,
                button,
            } => {
                self.dispatch_click_action(
                    &request.role_id,
                    anchor.as_deref(),
                    &unit,
                    x,
                    y,
                    &button,
                )?;
                Ok(None)
            }
        }
    }

    fn dispatch_key_action(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifiers: &[String],
        owner_id: &str,
    ) -> RuntimeResult<()> {
        self.with_role_input_lane(role_id, || {
            self.dispatch_key_action_in_lane(role_id, phase, code, modifiers, owner_id)
        })
    }

    fn dispatch_key_action_in_lane(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifiers: &[String],
        owner_id: &str,
    ) -> RuntimeResult<()> {
        let webview = self.role_webview(role_id)?;
        let modifier_codes = resolve_modifier_codes(modifiers, cfg!(target_os = "macos"))?;
        let transition =
            self.prepare_key_transition(role_id, phase, code, modifier_codes, owner_id)?;
        let mut executed = Vec::new();
        let dispatch_result = transition.effects.iter().try_for_each(|effect| {
            executed.push(effect.clone());
            dispatch_key_effect(&webview, effect)
        });
        match dispatch_result {
            Ok(()) => {
                if let Err(error) = self.complete_key_transition(&transition, true) {
                    for effect in executed.iter().rev() {
                        let compensation = compensated_key_effect(effect);
                        let _ = dispatch_key_effect(&webview, &compensation);
                    }
                    let _ = self.complete_key_transition(&transition, false);
                    return Err(error);
                }
                Ok(())
            }
            Err(error) => {
                for effect in executed.iter().rev() {
                    let compensation = compensated_key_effect(effect);
                    let _ = dispatch_key_effect(&webview, &compensation);
                }
                let _ = self.complete_key_transition(&transition, false);
                Err(error)
            }
        }
    }

    fn with_role_input_lane<T>(
        &self,
        role_id: &str,
        operation: impl FnOnce() -> RuntimeResult<T>,
    ) -> RuntimeResult<T> {
        let lane = {
            let mut lanes = self.input_dispatch_lanes.lock().map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_TRUSTED_INPUT_FAILED",
                    "The role input coordinator is unavailable.",
                )
            })?;
            Arc::clone(
                lanes
                    .entry(role_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = lane.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The role input lane is unavailable.",
            )
        })?;
        operation()
    }

    fn dispatch_click_action(
        &self,
        role_id: &str,
        anchor: Option<&str>,
        unit: &str,
        x: f64,
        y: f64,
        button: &str,
    ) -> RuntimeResult<()> {
        let webview = self.role_webview(role_id)?;
        let viewport = self.devtools_viewport(&webview)?;
        let point = resolve_click_point(anchor, unit, x, y, viewport)?;
        dispatch_mouse_effect(&webview, point, validate_mouse_button(button)?, true)?;
        if let Err(error) =
            dispatch_mouse_effect(&webview, point, validate_mouse_button(button)?, false)
        {
            let _ = dispatch_mouse_effect(&webview, point, validate_mouse_button(button)?, false);
            return Err(error);
        }
        Ok(())
    }

    fn devtools_viewport(&self, webview: &Webview) -> RuntimeResult<ViewportSize> {
        if let Ok(result) = call_system_devtools(webview, "Page.getLayoutMetrics", &json!({}))
            && let Some(viewport) = parse_devtools_viewport(&result)
        {
            return Ok(viewport);
        }
        let result = self.evaluate_webview(
            webview,
            "({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) })",
        )?;
        parse_evaluated_viewport(&result).ok_or_else(|| {
            RuntimeError::new(
                "BROWSER_VIEWPORT_UNAVAILABLE",
                "System WebView viewport size is unavailable.",
            )
        })
    }

    fn prepare_key_transition(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifier_codes: Vec<String>,
        owner_id: &str,
    ) -> RuntimeResult<EmbeddedKeyTransitionRecord> {
        self.core
            .invoke(CoreCommand::EmbeddedKeyPrepare {
                role_id: role_id.to_owned(),
                phase: phase.to_owned(),
                code: code.to_owned(),
                modifier_codes,
                owner_id: owner_id.to_owned(),
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value(value).map_err(|error| {
                    RuntimeError::new("TAURI_CORE_RESULT_INVALID", error.to_string())
                })
            })
    }

    fn complete_key_transition(
        &self,
        transition: &EmbeddedKeyTransitionRecord,
        succeeded: bool,
    ) -> RuntimeResult<()> {
        let Some(transition_id) = &transition.transition_id else {
            return Ok(());
        };
        self.core
            .invoke(CoreCommand::EmbeddedKeyComplete {
                transition_id: transition_id.clone(),
                succeeded,
            })
            .map(|_| ())
            .map_err(RuntimeError::core)
    }

    fn reassert_role_keys(&self, role_id: &str, webview: &Webview) -> RuntimeResult<()> {
        if !cfg!(windows) {
            return Ok(());
        }
        self.with_role_input_lane(role_id, || {
            self.reassert_role_keys_in_lane(role_id, webview)
        })
    }

    fn reassert_role_keys_in_lane(&self, role_id: &str, webview: &Webview) -> RuntimeResult<()> {
        self.reassert_role_keys_matching_in_lane(role_id, webview, |_| true)
    }

    fn reassert_role_keys_matching_in_lane(
        &self,
        role_id: &str,
        webview: &Webview,
        should_dispatch: impl Fn(&str) -> bool,
    ) -> RuntimeResult<()> {
        let transition = self
            .core
            .invoke(CoreCommand::EmbeddedKeysReassert {
                role_id: role_id.to_owned(),
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value::<EmbeddedKeyTransitionRecord>(value).map_err(|error| {
                    RuntimeError::new("TAURI_CORE_RESULT_INVALID", error.to_string())
                })
            })?;
        transition
            .effects
            .iter()
            .filter(|effect| should_dispatch(&effect.code))
            .try_for_each(|effect| dispatch_key_effect(webview, effect))
    }

    fn clear_role_keys(&self, role_id: &str) {
        let _ = self.core.invoke(CoreCommand::EmbeddedKeysClear {
            role_id: role_id.to_owned(),
        });
    }

    fn prepare_automation_focus(&self, role_id: &str) -> RuntimeResult<()> {
        let webview = self.role_webview(role_id)?;
        self.evaluate_webview(
            &webview,
            "(() => { try { window.focus(); const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body; target?.focus?.({ preventScroll: true }); return true; } catch { return false; } })()",
        )
        .map(|_| ())
    }

}
