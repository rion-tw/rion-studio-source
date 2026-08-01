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
                selectors,
                codec,
            } => {
                self.refresh_local_storage_sync_source(
                    &source_role_id,
                    &source_launch_url,
                    &origin,
                    &keys,
                    &selectors,
                    codec.as_deref(),
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
                    let _ = self
                        .prepare_destroy_tab_presentation(&tab_id, next_active_tab_id.as_deref())
                        .ok();
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
                local_storage_sync_selectors,
                local_storage_sync_codec,
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
                    &local_storage_sync_selectors,
                    local_storage_sync_codec.as_deref(),
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
        if !matches!(request.intent.as_str(), "normal" | "cleanup") {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_INVALID",
                "Browser action intent is invalid.",
            ));
        }
        let started = Instant::now();
        let diagnostic = browser_action_diagnostic_context(&request.action);
        let request_id = request.request_id.clone();
        let role_id = request.role_id.clone();
        let input_epoch = request.input_epoch;
        let intent = request.intent.clone();
        let scheduled_at_ms = request.scheduled_at_ms;
        let deadline_ms = request.deadline_ms;
        let result = (|| {
            let context = self.input_dispatch_context(&request)?;
            self.with_input_context_lane(&context, || match request.action {
                BrowserAction::Focus => {
                    // Native key and mouse delivery targets the role WebView directly. Focus is
                    // therefore a fenced readiness check, not permission to blur the game canvas
                    // or replace the foreground role's AppKit first responder.
                    self.role_webview_for_input(&role_id, &context)
                        .map(|_| None)
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
                    self.dispatch_key_action_in_lane(
                        &role_id,
                        &phase,
                        &code,
                        &modifiers,
                        &owner_id,
                        &context,
                    )?;
                    Ok(None)
                }
                BrowserAction::Click {
                    anchor,
                    unit,
                    x,
                    y,
                    button,
                } => {
                    let click = ClickActionDispatch {
                        anchor: anchor.as_deref(),
                        unit: &unit,
                        x,
                        y,
                        button: &button,
                    };
                    self.dispatch_click_action_in_lane(&role_id, &click, &context)?;
                    Ok(None)
                }
            })
        })();
        self.record_macro_browser_action_result(
            &request_id,
            &role_id,
            input_epoch,
            &intent,
            scheduled_at_ms,
            deadline_ms,
            diagnostic,
            started,
            &result,
        );
        result
    }

    fn dispatch_key_action_in_lane(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifiers: &[String],
        owner_id: &str,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        context.ensure_current()?;
        let webview = self.role_webview_for_input(role_id, context)?;
        let modifier_codes = resolve_modifier_codes(modifiers, cfg!(target_os = "macos"))?;
        let transition =
            self.prepare_key_transition(role_id, phase, code, modifier_codes, owner_id)?;
        let mut executed = Vec::new();
        let dispatch_result: RuntimeResult<()> = transition.effects.iter().try_for_each(|effect| {
            context.ensure_current()?;
            dispatch_key_effect(&webview, effect, context)?;
            executed.push(effect.clone());
            Ok(())
        });
        match dispatch_result {
            Ok(()) => {
                if let Err(error) = self.complete_key_transition(&transition, true) {
                    self.compensate_key_prefix(role_id, &webview, &executed, context);
                    let _ = self.complete_key_transition(&transition, false);
                    return Err(error);
                }
                Ok(())
            }
            Err(error) => {
                if error.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" {
                    self.quarantine_role_input(role_id, &error);
                }
                self.compensate_key_prefix(role_id, &webview, &executed, context);
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
        let lane = self.role_input_lane(role_id)?;
        let _guard = lane.sequence.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The role input lane is unavailable.",
            )
        })?;
        operation()
    }

    fn role_input_lane(&self, role_id: &str) -> RuntimeResult<Arc<RoleInputDispatchLane>> {
        let mut lanes = self.input_dispatch_lanes.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The role input coordinator is unavailable.",
            )
        })?;
        Ok(Arc::clone(
            lanes.entry(role_id.to_owned()).or_default(),
        ))
    }

    fn input_dispatch_context(
        &self,
        request: &BrowserActionRequest,
    ) -> RuntimeResult<InputDispatchContext> {
        if request.intent == "normal" && browser_action_deadline_expired(request.deadline_ms) {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_DEADLINE",
                "Browser action deadline expired.",
            ));
        }
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let monotonic_deadline = Instant::now()
            .checked_add(
                Duration::from_millis(request.deadline_ms.saturating_sub(now_ms))
                    .min(PLATFORM_CALLBACK_TIMEOUT),
            )
            .unwrap_or_else(Instant::now);
        let surface_generation = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(&request.role_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_ROLE_NOT_FOUND", "Runtime role was not found.")
            })?;
            if request.intent == "normal"
                && (state.close_coordinator.closing_roles.contains(&request.role_id)
                    || state
                        .close_coordinator
                        .quarantined_roles
                        .contains(&request.role_id))
            {
                return Err(RuntimeError::new(
                    "SYSTEM_TRUSTED_INPUT_QUARANTINED",
                    "The role is closing or quarantined and cannot accept automatic input.",
                ));
            }
            state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(&request.role_id))
                .map(|surface| surface.generation)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role surface was not found.",
                    )
                })?
        };
        let lane = self.role_input_lane(&request.role_id)?;
        let current_epoch = lane.epoch.load(Ordering::Acquire);
        if request.input_epoch < current_epoch {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action belongs to an obsolete role input epoch.",
            ));
        }
        if request.input_epoch > current_epoch {
            lane.epoch.store(request.input_epoch, Ordering::Release);
        }
        let known_generation = lane.surface_generation.load(Ordering::Acquire);
        if known_generation == 0 {
            lane.surface_generation
                .store(surface_generation, Ordering::Release);
        } else if known_generation != surface_generation {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action resolved after its System WebView surface changed.",
            ));
        }
        let context = InputDispatchContext {
            deadline: monotonic_deadline,
            input_epoch: request.input_epoch,
            intent: request.intent.clone(),
            lane,
            surface_generation,
        };
        context.ensure_current()?;
        Ok(context)
    }

    fn current_input_context(
        &self,
        role_id: &str,
        intent: &str,
    ) -> RuntimeResult<InputDispatchContext> {
        let lane = self.role_input_lane(role_id)?;
        let surface_generation = {
            let state = self.state()?;
            let tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
                RuntimeError::new("TAURI_RUNTIME_ROLE_NOT_FOUND", "Runtime role was not found.")
            })?;
            state
                .tabs
                .get(tab_id)
                .and_then(|tab| tab.roles.get(role_id))
                .map(|surface| surface.generation)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role surface was not found.",
                    )
                })?
        };
        if lane.surface_generation.load(Ordering::Acquire) == 0 {
            lane.surface_generation
                .store(surface_generation, Ordering::Release);
        }
        let context = InputDispatchContext {
            deadline: Instant::now() + PLATFORM_CALLBACK_TIMEOUT,
            input_epoch: lane.epoch.load(Ordering::Acquire),
            intent: intent.to_owned(),
            lane,
            surface_generation,
        };
        context.ensure_current()?;
        Ok(context)
    }

    fn cleanup_input_context(&self, context: &InputDispatchContext) -> InputDispatchContext {
        InputDispatchContext {
            deadline: Instant::now() + PLATFORM_CALLBACK_TIMEOUT,
            // A navigation or close fence can advance while mouseDown/keyDown is being
            // confirmed. Cleanup is the only work allowed to adopt that newer epoch; the
            // original normal action remains permanently stale.
            input_epoch: context.lane.epoch.load(Ordering::Acquire),
            intent: "cleanup".to_owned(),
            lane: Arc::clone(&context.lane),
            surface_generation: context.surface_generation,
        }
    }

    fn role_webview_for_input(
        &self,
        role_id: &str,
        context: &InputDispatchContext,
    ) -> RuntimeResult<Webview> {
        context.ensure_current()?;
        let state = self.state()?;
        if !context.is_cleanup()
            && (state.close_coordinator.closing_roles.contains(role_id)
                || state.close_coordinator.quarantined_roles.contains(role_id))
        {
            return Err(RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_QUARANTINED",
                "The role is closing or quarantined and cannot accept automatic input.",
            ));
        }
        let tab_id = state.role_tabs.get(role_id).ok_or_else(|| {
            RuntimeError::new("TAURI_RUNTIME_ROLE_NOT_FOUND", "Runtime role was not found.")
        })?;
        state
            .tabs
            .get(tab_id)
            .and_then(|tab| tab.roles.get(role_id))
            .filter(|surface| surface.generation == context.surface_generation)
            .map(|surface| surface.webview.clone())
            .ok_or_else(|| {
                RuntimeError::new(
                    "BROWSER_ACTION_STALE",
                    "The System WebView surface changed before input dispatch.",
                )
            })
    }

    fn compensate_key_prefix(
        &self,
        role_id: &str,
        webview: &Webview,
        executed: &[EmbeddedKeyEffectRecord],
        context: &InputDispatchContext,
    ) {
        let cleanup = self.cleanup_input_context(context);
        for effect in key_prefix_compensation(executed) {
            if let Err(error) = dispatch_key_effect(webview, &effect, &cleanup) {
                self.quarantine_role_input(role_id, &error);
                break;
            }
        }
    }

    fn dispatch_click_action_in_lane(
        &self,
        role_id: &str,
        click: &ClickActionDispatch<'_>,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        let webview = self.role_webview_for_input(role_id, context)?;
        let viewport = self.devtools_viewport(&webview)?;
        context.ensure_current()?;
        let point = resolve_click_point(click.anchor, click.unit, click.x, click.y, viewport)?;
        let button = validate_mouse_button(click.button)?;
        self.record_macro_click_resolution(role_id, click, viewport, point, context);
        if let Err(error) = dispatch_mouse_input_sequence(
            context,
            || self.cleanup_input_context(context),
            |pressed, context| {
                dispatch_mouse_effect(&webview, viewport, point, button, pressed, context)
            },
        ) {
            if let Some(cleanup_error) = error.cleanup.as_ref() {
                self.quarantine_role_input(role_id, cleanup_error);
            } else if error.down_confirmed {
                self.quarantine_role_input(role_id, &error.action);
            }
            return Err(error.action);
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

    fn reassert_role_keys(&self, role_id: &str, _webview: &Webview) -> RuntimeResult<()> {
        if !cfg!(windows) {
            return Ok(());
        }
        let context = self.current_input_context(role_id, "normal")?;
        self.with_input_context_lane(&context, || {
            self.reassert_role_keys_in_lane(role_id, &context)
        })
    }

    fn reassert_role_keys_in_lane(
        &self,
        role_id: &str,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        self.reassert_role_keys_matching_in_lane(role_id, context, |_| true)
    }

    fn reassert_role_keys_matching_in_lane(
        &self,
        role_id: &str,
        context: &InputDispatchContext,
        should_dispatch: impl Fn(&str) -> bool,
    ) -> RuntimeResult<()> {
        let webview = self.role_webview_for_input(role_id, context)?;
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
        let mut executed = Vec::new();
        let result: RuntimeResult<()> = transition
            .effects
            .iter()
            .filter(|effect| should_dispatch(&effect.code))
            .try_for_each(|effect| {
                dispatch_key_effect(&webview, effect, context)?;
                executed.push(effect.clone());
                Ok(())
            });
        if let Err(error) = result {
            let cleanup = self.cleanup_input_context(context);
            for effect in release_reasserted_key_effects(&executed) {
                if let Err(cleanup_error) = dispatch_key_effect(&webview, &effect, &cleanup) {
                    self.quarantine_role_input(role_id, &cleanup_error);
                    break;
                }
            }
            if error.code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE" {
                self.quarantine_role_input(role_id, &error);
            }
            return Err(error);
        }
        Ok(())
    }

    fn clear_role_keys(&self, role_id: &str) {
        let _ = self.core.invoke(CoreCommand::EmbeddedKeysClear {
            role_id: role_id.to_owned(),
        });
    }

}
